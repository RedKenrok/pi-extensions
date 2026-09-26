import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	createNotifyExtension,
	type ExecFile,
	type NotifyOptions,
} from "../index.ts";

type SettledHandler = (event: unknown, ctx: ExtensionContext) => void;

// The only context members the extension reads. Typing the fake against Pi's
// own types means a renamed member fails type-checking instead of at runtime.
type NotifyContextFake = Pick<ExtensionContext, "mode" | "cwd"> & {
	sessionManager: Pick<
		ExtensionContext["sessionManager"],
		"getSessionName" | "getSessionId"
	>;
};

interface ToastCall {
	file: string;
	args: string[];
	callback: (error: Error | null) => void;
}

function harness(
	env: NodeJS.ProcessEnv,
	mode: ExtensionContext["mode"] = "tui",
	name?: string,
	overrides: Partial<NotifyOptions> & {
		cwd?: string;
		sessionId?: string;
	} = {},
) {
	const registered: string[] = [];
	const output: string[] = [];
	const errors: string[] = [];
	const toasts: ToastCall[] = [];
	let handler: SettledHandler | undefined;
	const { cwd, sessionId, ...options } = overrides;
	const execFile: ExecFile = (file, args, _options, callback) => {
		toasts.push({ file, args, callback });
	};
	createNotifyExtension({
		env,
		platform: "linux",
		isTTY: () => true,
		write: (text) => {
			output.push(text);
		},
		writeError: (text) => {
			errors.push(text);
		},
		execFile,
		...options,
	})({
		on(event: string, fn: SettledHandler) {
			registered.push(event);
			handler = fn;
		},
	} as Pick<ExtensionAPI, "on"> as ExtensionAPI);
	const ctx: NotifyContextFake = {
		mode,
		cwd: cwd ?? "/work/my-project",
		sessionManager: {
			getSessionName: () => name,
			getSessionId: () => sessionId ?? "abc12345-6789",
		},
	};
	return {
		registered,
		output,
		errors,
		toasts,
		settle() {
			assert.ok(handler);
			handler({}, ctx as ExtensionContext);
		},
	};
}

const script = (call: ToastCall | undefined) => call?.args[2] ?? "";

test("notifies only when the interactive agent settles", () => {
	const runtime = harness({});
	assert.deepEqual(runtime.registered, ["agent_settled"]);
	assert.deepEqual(runtime.output, []);
	runtime.settle();
	assert.deepEqual(runtime.output, [
		"\x1b]777;notify;Pi: my-project;Thread (abc12345): Ready for input\x07",
	]);
	runtime.settle();
	assert.equal(runtime.output.length, 2);
	const print = harness({}, "print");
	print.settle();
	assert.deepEqual(print.output, []);
	const rpc = harness({}, "rpc");
	rpc.settle();
	assert.deepEqual(rpc.output, []);
	const noTerminal = harness({}, "tui", undefined, { isTTY: () => false });
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
	const body = ":p=body;Review changes (abc12345): Ready for input\x1b\\";
	assert.equal(runtime.output[1], `${prefix}${first}${body}`);
	assert.equal(runtime.output[3], `${prefix}${second}${body}`);
});

test("wraps sequences in screen passthrough and ends Kitty OSC with BEL", () => {
	const osc777 = harness({ STY: "1234.pts-0.host" });
	osc777.settle();
	assert.deepEqual(osc777.output, [
		"\x1bP\x1b]777;notify;Pi: my-project;Thread (abc12345): Ready for input\x07\x1b\\",
	]);

	const kitty = harness({ STY: "1234.pts-0.host", KITTY_WINDOW_ID: "1" });
	kitty.settle();
	assert.equal(kitty.output.length, 2);
	for (const sequence of kitty.output) {
		assert.ok(sequence.startsWith("\x1bP\x1b]99;i="));
		assert.ok(sequence.endsWith("\x07\x1b\\"));
		// A single ST inside the payload would end screen's passthrough early.
		assert.equal(sequence.indexOf("\x1b\\"), sequence.length - 2);
	}
});

test("tmux takes precedence over an outer screen session", () => {
	const nested = harness({ STY: "1234.pts-0.host", TMUX: "/tmp/tmux" });
	nested.settle();
	assert.ok(nested.output[0]?.startsWith("\x1bPtmux;"));
});

test("wraps sequences in tmux passthrough with doubled escapes", () => {
	const osc777 = harness({ TMUX: "/tmp/tmux-1/default,1,0" });
	osc777.settle();
	assert.deepEqual(osc777.output, [
		"\x1bPtmux;\x1b\x1b]777;notify;Pi: my-project;Thread (abc12345): Ready for input\x07\x1b\\",
	]);

	const kitty = harness({ TMUX: "/tmp/tmux", KITTY_WINDOW_ID: "1" });
	kitty.settle();
	assert.equal(kitty.output.length, 2);
	for (const sequence of kitty.output) {
		assert.ok(sequence.startsWith("\x1bPtmux;\x1b\x1b]99;i="));
		assert.ok(sequence.endsWith("\x1b\x1b\\\x1b\\"));
	}
});

test("sanitizes controls, bidi marks, separators, whitespace, and long labels", () => {
	const runtime = harness({}, "tui", " ‮Hello;\n  ⁦world  ", {
		cwd: `/work/${"🦊".repeat(90)};\x07`,
		sessionId: "abc;\x1bdefGH",
	});
	runtime.settle();
	assert.deepEqual(runtime.output, [
		`\x1b]777;notify;Pi: ${"🦊".repeat(80)};Hello world (abc defG): Ready for input\x07`,
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
		assert.deepEqual(runtime.errors, []);
	}
	const windows = harness({ WT_SESSION: "session" }, "tui", undefined, {
		platform: "win32",
		execFile: () => {
			throw new Error("spawn failed");
		},
	});
	assert.doesNotThrow(() => windows.settle());
});

test("Windows Terminal toasts only on Windows or WSL and take precedence", () => {
	const native = harness(
		{ WT_SESSION: "session", KITTY_WINDOW_ID: "1" },
		"tui",
		"Owner's; \x1b[31m",
		{ platform: "win32" },
	);
	native.settle();
	assert.deepEqual(native.output, []);
	assert.equal(native.toasts.length, 1);
	assert.equal(native.toasts[0]?.file, "powershell.exe");
	assert.deepEqual(native.toasts[0]?.args.slice(0, 2), [
		"-NoProfile",
		"-Command",
	]);
	assert.ok(
		script(native.toasts[0]).includes(
			"CreateTextNode('Owner''s [31m (abc12345): Ready for input')",
		),
	);
	assert.ok(
		script(native.toasts[0]).includes("CreateToastNotifier('Pi: my-project')"),
	);

	const wsl = harness({ WT_SESSION: "session", WSL_DISTRO_NAME: "Ubuntu" });
	wsl.settle();
	assert.equal(wsl.toasts.length, 1);
	assert.deepEqual(wsl.output, []);

	// An inherited WT_SESSION on a remote Linux shell has no powershell.exe.
	const remote = harness({ WT_SESSION: "session" });
	remote.settle();
	assert.equal(remote.toasts.length, 0);
	assert.equal(remote.output.length, 1);
});

test("escapes apostrophes and newlines in the toast title", () => {
	const runtime = harness({ WT_SESSION: "session" }, "tui", undefined, {
		platform: "win32",
		cwd: "/work/it's\nmine",
	});
	runtime.settle();
	assert.ok(
		script(runtime.toasts[0]).includes("CreateToastNotifier('Pi: it''s mine')"),
	);
	assert.ok(!script(runtime.toasts[0]).includes("\n"));
});

test("keeps at most one toast process in flight", () => {
	const runtime = harness({ WT_SESSION: "session" }, "tui", undefined, {
		platform: "win32",
	});
	runtime.settle();
	runtime.settle();
	assert.equal(runtime.toasts.length, 1);
	runtime.toasts[0]?.callback(null);
	runtime.settle();
	assert.equal(runtime.toasts.length, 2);
	runtime.toasts[1]?.callback(new Error("timeout"));
	runtime.settle();
	assert.equal(runtime.toasts.length, 3);
});

test("reports delivery failures on stderr only when debugging is enabled", () => {
	const failingWrite = () => {
		throw new Error("EPIPE");
	};
	const quiet = harness({}, "tui", undefined, { write: failingWrite });
	quiet.settle();
	assert.deepEqual(quiet.errors, []);

	const named = harness({ PI_EXT_DEBUG: "fetch-tool, pi-notify" }, "tui", "", {
		write: failingWrite,
	});
	named.settle();
	assert.deepEqual(named.errors, ["[pi-notify] write_failed\n"]);

	const other = harness({ PI_EXT_DEBUG: "fetch-tool" }, "tui", "", {
		write: failingWrite,
	});
	other.settle();
	assert.deepEqual(other.errors, []);

	const toasts = harness(
		{ WT_SESSION: "session", PI_EXT_DEBUG: "*" },
		"tui",
		undefined,
		{ platform: "win32" },
	);
	toasts.settle();
	toasts.settle();
	toasts.toasts[0]?.callback(new Error("exit 1"));
	assert.deepEqual(toasts.errors, [
		"[pi-notify] toast_busy\n",
		"[pi-notify] toast_failed\n",
	]);

	const spawn = harness(
		{ WT_SESSION: "session", PI_EXT_DEBUG: "*" },
		"tui",
		undefined,
		{
			platform: "win32",
			execFile: () => {
				throw new Error("ENOENT");
			},
		},
	);
	spawn.settle();
	spawn.settle();
	assert.deepEqual(spawn.errors, [
		"[pi-notify] toast_spawn_failed\n",
		"[pi-notify] toast_spawn_failed\n",
	]);

	const brokenStderr = harness({ PI_EXT_DEBUG: "*" }, "tui", undefined, {
		write: failingWrite,
		writeError: () => {
			throw new Error("EPIPE");
		},
	});
	assert.doesNotThrow(() => brokenStderr.settle());
});

test("partial options keep the remaining defaults", () => {
	const output: string[] = [];
	let handler: SettledHandler | undefined;
	createNotifyExtension({
		env: {},
		isTTY: () => true,
		write: (text) => {
			output.push(text);
		},
	})({
		on(_event: string, fn: SettledHandler) {
			handler = fn;
		},
	} as Pick<ExtensionAPI, "on"> as ExtensionAPI);
	const ctx: NotifyContextFake = {
		mode: "tui",
		cwd: "/work/defaults",
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "id",
		},
	};
	handler?.({}, ctx as ExtensionContext);
	assert.equal(output.length, 1);
	assert.ok(output[0]?.includes("Pi: defaults"));
});
