import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Keep dynamic labels short, single-line, and safe for OSC and toast text.
function label(value: string): string {
	const safe = Array.from(value, (char) => {
		const code = char.codePointAt(0) ?? 0;
		// Format characters include bidi overrides and isolates, which can disguise labels.
		if (/\p{Cf}/u.test(char)) return "";
		return code < 32 ||
			(code >= 127 && code <= 159) ||
			char === ";" ||
			/\s/u.test(char)
			? " "
			: char;
	});
	return Array.from(safe.join("").replace(/ +/g, " ").trim())
		.slice(0, 80)
		.join("")
		.trim();
}

function notificationText(ctx: ExtensionContext) {
	const project = label(basename(ctx.cwd)) || "workspace";
	const thread = label(ctx.sessionManager.getSessionName() ?? "") || "Thread";
	const id =
		Array.from(label(ctx.sessionManager.getSessionId())).slice(0, 8).join("") ||
		"unknown";
	return {
		title: `Pi: ${project}`,
		body: `${thread} (${id}) — Ready for input`,
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

type NotifyOptions = {
	env: NodeJS.ProcessEnv;
	isTTY: () => boolean;
	write: (text: string) => void;
	toast: (script: string) => void;
};

export function createNotifyExtension(
	options: NotifyOptions = {
		env: process.env,
		isTTY: () => process.stdout.isTTY === true,
		write: (text) => {
			process.stdout.write(text);
		},
		toast: (script) => {
			// Notification delivery is best-effort; a missing PowerShell must not fail the run.
			execFile(
				"powershell.exe",
				["-NoProfile", "-Command", script],
				{ timeout: 3000, windowsHide: true },
				() => {},
			);
		},
	},
) {
	return (pi: ExtensionAPI) => {
		// Unlike agent_end, agent_settled fires only after retries and queued work finish.
		pi.on("agent_settled", (_event, ctx) => {
			if (ctx.mode !== "tui" || !options.isTTY()) return;
			// Delivery is best-effort; a broken terminal or toast must not fail Pi's run.
			try {
				const { title, body } = notificationText(ctx);
				if (options.env.WT_SESSION) {
					options.toast(windowsToastScript(title, body));
				} else if (options.env.KITTY_WINDOW_ID) {
					// Unique IDs prevent separate threads/runs from replacing one another.
					// Kitty's default click action focuses the originating window.
					const id = randomUUID();
					options.write(`\x1b]99;i=${id}:d=0;${title}\x1b\\`);
					options.write(`\x1b]99;i=${id}:p=body;${body}\x1b\\`);
				} else {
					options.write(`\x1b]777;notify;${title};${body}\x07`);
				}
			} catch {
				// Notifications are optional; never surface a delivery error to the user.
			}
		});
	};
}

export default createNotifyExtension();
