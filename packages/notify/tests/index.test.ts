import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createNotifyExtension } from "../index.ts";

function harness(
	env: NodeJS.ProcessEnv,
	mode = "tui",
	name?: string,
	overrides: {
		isTTY?: boolean;
		cwd?: string;
		sessionId?: string;
		write?: (text: string) => void;
		toast?: (script: string) => void;
	} = {},
) {
	const registered: string[] = [];
	const output: string[] = [];
	const toasts: string[] = [];
	let handler: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
	createNotifyExtension({
		env,
		isTTY: () => overrides.isTTY ?? true,
		write:
			overrides.write ??
			((text) => {
				output.push(text);
			}),
		toast:
			overrides.toast ??
			((script) => {
				toasts.push(script);
			}),
	})({
		on(event: string, fn: typeof handler) {
			registered.push(event);
			handler = fn;
		},
	} as unknown as ExtensionAPI);
	return {
		registered,
		output,
		toasts,
		settle() {
			assert.ok(handler);
			handler({}, {
				mode,
				cwd: overrides.cwd ?? "/work/my-project",
				sessionManager: {
					getSessionName: () => name,
					getSessionId: () => overrides.sessionId ?? "abc12345-6789",
				},
			} as ExtensionContext);
		},
	};
}

test("notifies only when the interactive agent settles", () => {
	const runtime = harness({});
	assert.deepEqual(runtime.registered, ["agent_settled"]);
	assert.deepEqual(runtime.output, []);
	runtime.settle();
	assert.deepEqual(runtime.output, [
		"\x1b]777;notify;Pi: my-project;Thread (abc12345) — Ready for input\x07",
	]);
	runtime.settle();
	assert.equal(runtime.output.length, 2);
	const print = harness({}, "print");
	print.settle();
	assert.deepEqual(print.output, []);
	const rpc = harness({}, "rpc");
	rpc.settle();
	assert.deepEqual(rpc.output, []);
	const noTerminal = harness({}, "tui", undefined, { isTTY: false });
	noTerminal.settle();
	assert.deepEqual(noTerminal.output, []);
});

test("Kitty uses distinct notification IDs and includes the thread name", () => {
	const runtime = harness({ KITTY_WINDOW_ID: "1" }, "tui", "Review changes");
	runtime.settle();
	runtime.settle();
	assert.equal(runtime.output.length, 4);
	const prefix = "\x1b]99;i=";
	const first = runtime.output[0]?.split(":d=0;")[0]?.slice(prefix.length);
	const second = runtime.output[2]?.split(":d=0;")[0]?.slice(prefix.length);
	assert.ok(first);
	assert.ok(second);
	assert.notEqual(first, second);
	assert.equal(runtime.output[0], `${prefix}${first}:d=0;Pi: my-project\x1b\\`);
	assert.equal(
		runtime.output[2],
		`${prefix}${second}:d=0;Pi: my-project\x1b\\`,
	);
	const body = ":p=body;Review changes (abc12345) — Ready for input\x1b\\";
	assert.equal(runtime.output[1], `${prefix}${first}${body}`);
	assert.equal(runtime.output[3], `${prefix}${second}${body}`);
});

test("sanitizes controls, bidi marks, separators, whitespace, and long labels", () => {
	const runtime = harness({}, "tui", " \u202eHello;\n  \u2066world  ", {
		cwd: `/work/${"🦊".repeat(90)};\x07`,
		sessionId: "abc;\x1bdefGH",
	});
	runtime.settle();
	assert.deepEqual(runtime.output, [
		`\x1b]777;notify;Pi: ${"🦊".repeat(80)};Hello world (abc defG) — Ready for input\x07`,
	]);
});

test("a failed notification does not interrupt the settled event", () => {
	for (const env of [{}, { KITTY_WINDOW_ID: "1" }]) {
		let writes = 0;
		const runtime = harness(env, "tui", undefined, {
			write: () => {
				writes++;
				throw new Error("EPIPE");
			},
		});
		assert.doesNotThrow(() => runtime.settle());
		assert.equal(writes, 1);
	}
	const windows = harness({ WT_SESSION: "session" }, "tui", undefined, {
		toast: () => {
			throw new Error("spawn failed");
		},
	});
	assert.doesNotThrow(() => windows.settle());
});

test("Windows Terminal takes precedence and escapes thread text in the toast", () => {
	const runtime = harness(
		{ WT_SESSION: "session", KITTY_WINDOW_ID: "1" },
		"tui",
		"Owner's; \x1b[31m",
	);
	runtime.settle();
	assert.deepEqual(runtime.output, []);
	assert.equal(runtime.toasts.length, 1);
	assert.ok(
		runtime.toasts[0]?.includes(
			"CreateTextNode('Owner''s [31m (abc12345) — Ready for input')",
		),
	);
	assert.ok(
		runtime.toasts[0]?.includes("CreateToastNotifier('Pi: my-project')"),
	);
});
