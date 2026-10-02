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
const DEFAULT_MIN_RUN_MS = 10_000;
type Backends = ReturnType<typeof createBackends>;
type Delivery = "auto" | "off" | keyof Backends;

function delivery(env: NodeJS.ProcessEnv, backends: Backends): Delivery {
	const value = env.PI_NOTIFY_METHOD;
	if (value === "off") return "off";
	if (value && Object.hasOwn(backends, value)) return value as keyof Backends;
	return "auto";
}

function minimumRunMs(env: NodeJS.ProcessEnv): number {
	const value = env.PI_NOTIFY_MIN_RUN_MS;
	if (value === undefined) return DEFAULT_MIN_RUN_MS;
	const number = Number(value);
	return Number.isSafeInteger(number) && number >= 0
		? number
		: DEFAULT_MIN_RUN_MS;
}

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
	now: () => number;
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
	now: () => performance.now(),
});

type NotificationText = ReturnType<typeof notificationText>;
type Backend = {
	matches: () => boolean;
	send: (text: NotificationText) => void;
};

// Entries are checked in order for automatic delivery. Add a backend here to
// support both automatic detection and an explicit PI_NOTIFY_METHOD value.
function createBackends(
	options: NotifyOptions,
	toast: (script: string) => void,
) {
	return {
		toast: {
			// WT_SESSION can reach remote shells without powershell.exe.
			matches: () =>
				Boolean(options.env.WT_SESSION) &&
				(options.platform === "win32" || Boolean(options.env.WSL_DISTRO_NAME)),
			send: ({ title, body }) => toast(windowsToastScript(title, body)),
		},
		kitty: {
			matches: () => Boolean(options.env.KITTY_WINDOW_ID),
			send: ({ title, body }) => {
				// Unique IDs prevent separate threads/runs from replacing one another.
				// Kitty's default click action focuses the originating window.
				const id = randomUUID();
				const end = oscEnd(options.env);
				options.write(
					forTerminal(`\x1b]99;i=${id}:d=0;${title}${end}`, options.env) +
						forTerminal(`\x1b]99;i=${id}:p=body;${body}${end}`, options.env),
				);
			},
		},
		osc777: {
			// TERM_PROGRAM identifies CotEditorPatch and WezTerm; foot only offers
			// a TERM hint. These values can be replaced by nested terminals.
			matches: () =>
				["CotEditorPatch", "WezTerm"].includes(
					options.env.TERM_PROGRAM ?? "",
				) || ["foot", "foot-extra"].includes(options.env.TERM ?? ""),
			send: ({ title, body }) => {
				options.write(
					forTerminal(`\x1b]777;notify;${title};${body}\x07`, options.env),
				);
			},
		},
		osc9: {
			matches: () =>
				["iTerm.app", "ghostty"].includes(options.env.TERM_PROGRAM ?? ""),
			send: ({ title, body }) => {
				// OSC 9 has only one message field, so include the title inline.
				options.write(forTerminal(`\x1b]9;${title}: ${body}\x07`, options.env));
			},
		},
	} satisfies Record<string, Backend>;
}

function selectBackend(
	method: Delivery,
	backends: Backends,
): Backend | undefined {
	if (method === "off") return undefined;
	if (method === "auto") {
		return Object.values(backends).find((backend) => backend.matches());
	}
	return backends[method];
}

export function createNotifyExtension(overrides: Partial<NotifyOptions> = {}) {
	const options: NotifyOptions = { ...defaultOptions(), ...overrides };
	const debug = createDiagnostics(PACKAGE_NAME, {
		env: options.env,
		write: options.writeError,
	});

	// A cold PowerShell start takes up to a second, so rapid settles would
	// otherwise stack processes that all show the same notification.
	let toastInFlight = false;
	let pendingToast: string | undefined;
	const toast = (script: string): void => {
		if (toastInFlight) {
			pendingToast = script;
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
					const next = pendingToast;
					pendingToast = undefined;
					if (next !== undefined) toast(next);
				},
			);
		} catch {
			toastInFlight = false;
			debug("toast_spawn_failed");
		}
	};

	const backends = createBackends(options, toast);
	const method = delivery(options.env, backends);
	const minRunMs = minimumRunMs(options.env);
	let startedAt: number | undefined;
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", () => {
			startedAt = options.now();
		});
		// Unlike agent_end, agent_settled fires only after retries and queued work finish.
		pi.on("agent_settled", (_event, ctx) => {
			const start = startedAt;
			startedAt = undefined;
			if (ctx.mode !== "tui" || !options.isTTY() || method === "off") return;
			if (
				minRunMs > 0 &&
				(start === undefined || options.now() - start < minRunMs)
			)
				return;
			const backend = selectBackend(method, backends);
			if (!backend) return;
			// Delivery is best-effort; a broken terminal or toast must not fail Pi's run.
			try {
				backend.send(notificationText(ctx));
			} catch {
				debug("write_failed");
			}
		});
	};
}

export default createNotifyExtension();
