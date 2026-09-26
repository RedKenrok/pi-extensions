import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createDiagnostics } from "shared/diagnostics";

const PACKAGE_NAME = "notify";
const TOAST_TIMEOUT_MS = 3000;

// Keep dynamic labels short, single-line, and safe for OSC and toast text.
function label(value: string): string {
	const collapsed = value
		// Format characters include bidi overrides and isolates, which can disguise labels.
		.replace(/\p{Cf}/gu, "")
		// Controls could end or inject escape sequences, and ";" separates OSC fields.
		.replace(/[\p{Cc};\s]/gu, " ")
		.replace(/ +/g, " ")
		.trim();
	return Array.from(collapsed).slice(0, 80).join("").trim();
}

function notificationText(ctx: ExtensionContext) {
	const project = label(basename(ctx.cwd)) || "workspace";
	const thread = label(ctx.sessionManager.getSessionName() ?? "") || "Thread";
	const id =
		Array.from(label(ctx.sessionManager.getSessionId())).slice(0, 8).join("") ||
		"unknown";
	return {
		title: `Pi: ${project}`,
		body: `${thread} (${id}): Ready for input`,
	};
}

// PowerShell single-quoted strings escape apostrophes by doubling them.
function psString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	return [
		`[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent([${type}.ToastTemplateType]::ToastText01)`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode(${psString(body)})) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier(${psString(title)}).Show([${type}.ToastNotification]::new($xml))`,
	].join("; ");
}

type Multiplexer = "tmux" | "screen" | undefined;

// The innermost multiplexer owns the pty Pi writes to, and tmux sets TMUX even
// when started inside screen, so TMUX wins.
function multiplexer(env: NodeJS.ProcessEnv): Multiplexer {
	if (env.TMUX) return "tmux";
	if (env.STY) return "screen";
	return undefined;
}

// Multiplexers drop unknown escape sequences unless they arrive inside a DCS
// passthrough. tmux needs every ESC of the payload doubled. screen ends the
// passthrough at the first ST, so sequences sent through it must end in BEL
// (see oscEnd).
function forTerminal(sequence: string, env: NodeJS.ProcessEnv): string {
	switch (multiplexer(env)) {
		case "tmux":
			return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
		case "screen":
			return `\x1bP${sequence}\x1b\\`;
		default:
			return sequence;
	}
}

// Kitty accepts BEL as well as ST to end an OSC. ST is the documented form, so
// it is used everywhere except inside screen, whose passthrough ST would cut
// short.
function oscEnd(env: NodeJS.ProcessEnv): string {
	return multiplexer(env) === "screen" ? "\x07" : "\x1b\\";
}

export type ExecFile = (
	file: string,
	args: string[],
	options: { timeout: number; windowsHide: boolean },
	callback: (error: Error | null) => void,
) => unknown;

export type NotifyOptions = {
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	isTTY: () => boolean;
	write: (text: string) => void;
	writeError: (text: string) => void;
	execFile: ExecFile;
};

const defaultOptions = (): NotifyOptions => ({
	env: process.env,
	platform: process.platform,
	isTTY: () => process.stdout.isTTY === true,
	write: (text) => {
		process.stdout.write(text);
	},
	writeError: (text) => {
		process.stderr.write(text);
	},
	execFile: nodeExecFile,
});

export function createNotifyExtension(overrides: Partial<NotifyOptions> = {}) {
	const options: NotifyOptions = { ...defaultOptions(), ...overrides };
	const debug = createDiagnostics(PACKAGE_NAME, {
		env: options.env,
		write: options.writeError,
	});

	// A cold PowerShell start takes up to a second, so rapid settles would
	// otherwise stack processes that all show the same notification.
	let toastInFlight = false;
	const toast = (script: string): void => {
		if (toastInFlight) {
			debug("toast_busy");
			return;
		}
		toastInFlight = true;
		try {
			options.execFile(
				"powershell.exe",
				["-NoProfile", "-Command", script],
				{ timeout: TOAST_TIMEOUT_MS, windowsHide: true },
				(error) => {
					toastInFlight = false;
					if (error) debug("toast_failed");
				},
			);
		} catch {
			toastInFlight = false;
			debug("toast_spawn_failed");
		}
	};

	// WT_SESSION is inherited by nested and remote shells, where powershell.exe
	// does not exist, so it only selects toasts on Windows or inside WSL.
	const useToast = () =>
		Boolean(options.env.WT_SESSION) &&
		(options.platform === "win32" || Boolean(options.env.WSL_DISTRO_NAME));

	return (pi: ExtensionAPI) => {
		// Unlike agent_end, agent_settled fires only after retries and queued work finish.
		pi.on("agent_settled", (_event, ctx) => {
			if (ctx.mode !== "tui" || !options.isTTY()) return;
			// Delivery is best-effort; a broken terminal or toast must not fail Pi's run.
			try {
				const { title, body } = notificationText(ctx);
				if (useToast()) {
					toast(windowsToastScript(title, body));
				} else if (options.env.KITTY_WINDOW_ID) {
					// Unique IDs prevent separate threads/runs from replacing one another.
					// Kitty's default click action focuses the originating window.
					const id = randomUUID();
					const end = oscEnd(options.env);
					options.write(
						forTerminal(`\x1b]99;i=${id}:d=0;${title}${end}`, options.env),
					);
					options.write(
						forTerminal(`\x1b]99;i=${id}:p=body;${body}${end}`, options.env),
					);
				} else {
					options.write(
						forTerminal(`\x1b]777;notify;${title};${body}\x07`, options.env),
					);
				}
			} catch {
				debug("write_failed");
			}
		});
	};
}

export default createNotifyExtension();
