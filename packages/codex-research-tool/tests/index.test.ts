import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { deferred, nextTurn } from "../../../test-support/async.ts";
import { partialFake } from "../../../test-support/fakes.ts";
import { createResearchExtension, type ResearchHost } from "../index.ts";
import {
	type CodexResearchResult,
	type ResearchBackend,
	ResearchError,
} from "../src/codex.ts";
import { type createResearchTool, TOOL_DESCRIPTION } from "../src/search.ts";

// Pi's handlers each expect their own event type, so a fake that stores them
// side by side can only accept "some event". Emitting casts the event instead.
type Handler = (event: never, ctx: ExtensionContext) => unknown;
type CommandOptions = Parameters<ResearchHost["registerCommand"]>[1];
type ResearchTool = ReturnType<typeof createResearchTool>;

const answer: CodexResearchResult = {
	answer: "answer",
	citations: [],
	model: "model",
	searchActivity: 1,
};

function backend(overrides: Partial<ResearchBackend> = {}): ResearchBackend {
	return {
		invalidateModel() {},
		selectModel: async () => "model",
		runResearch: async () => answer,
		...overrides,
	};
}

function harness(options: {
	credential: () => Record<string, unknown> | undefined;
	token?: () => Promise<string | undefined>;
	client?: ResearchBackend;
}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandOptions["handler"]>();
	const tools = new Map<string, ResearchTool>();
	let active = ["read", "other_tool"];
	const notifications: string[] = [];
	const api = partialFake<ResearchHost>({
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			// Pi 0.87 returns an unsubscribe function from on(); 0.85 returns void,
			// which a function-returning fake also satisfies.
			return () => {
				handlers.set(
					name,
					(handlers.get(name) ?? []).filter((entry) => entry !== handler),
				);
			};
		},
		registerCommand(name: string, definition: CommandOptions) {
			commands.set(name, definition.handler);
		},
		registerTool<TParams extends TSchema, TDetails, TState>(
			tool: ToolDefinition<TParams, TDetails, TState>,
		) {
			// Pi's registerTool is generic, so storing tools side by side erases
			// their parameter types; this extension only registers the research tool.
			tools.set(tool.name, tool as ToolDefinition as ResearchTool);
			active = [...new Set([...active, tool.name])];
		},
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = [...names];
		},
	});
	// Command handlers receive the richer command context; it also satisfies
	// every event handler, so one fake serves both.
	const ctx = partialFake<ExtensionCommandContext>({
		mode: "tui",
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
		modelRegistry: {
			getApiKeyForProvider: options.token ?? (async () => "token"),
		},
		model: { provider: "other", id: "conversation" },
	});
	createResearchExtension({
		readCredential: () => options.credential() as never,
		resolveAccessToken: async () => (options.token ? options.token() : "token"),
		client: options.client ?? backend(),
	})(api);

	return {
		api,
		ctx,
		tools,
		commands,
		notifications,
		active: () => [...active],
		setActive(names: string[]) {
			active = names;
		},
		async emit(name: string) {
			for (const handler of handlers.get(name) ?? [])
				await handler({ type: name } as never, ctx);
		},
		async command(args: string) {
			await commands.get("research")?.(args, ctx);
		},
		captureProviderRequest() {
			const activeTools = [...tools.values()].filter((tool) =>
				active.includes(tool.name),
			);
			return {
				instructions: activeTools
					.flatMap((tool) => [
						tool.promptSnippet,
						...(tool.promptGuidelines ?? []),
					])
					.filter(Boolean)
					.join("\n"),
				tools: activeTools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			};
		},
	};
}

test("fresh signed-out provider payload has neither schema nor research instructions", async () => {
	const runtime = harness({ credential: () => undefined });
	await runtime.emit("session_start");
	const payload = runtime.captureProviderRequest();
	assert.equal(runtime.tools.has("research"), false);
	assert.equal(
		payload.tools.some((tool) => tool.name === "research"),
		false,
	);
	assert.equal(JSON.stringify(payload).includes(TOOL_DESCRIPTION), false);
	assert.deepEqual(runtime.active(), ["read", "other_tool"]);
	assert.match(runtime.notifications[0] ?? "", /\/login openai-codex/);
	await runtime.emit("before_agent_start");
	assert.equal(
		runtime.notifications.length,
		1,
		"transition warning is emitted once",
	);
});

test("credential loss from a tool call is recovered by a later availability check", async () => {
	let credential: Record<string, unknown> | undefined = {
		type: "oauth",
		accountId: "account",
	};
	const runtime = harness({ credential: () => credential });
	await runtime.emit("session_start");
	const tool = runtime.tools.get("research");
	assert.ok(tool);

	credential = undefined;
	await assert.rejects(
		tool.execute(
			"signed-out",
			{ query: "q" },
			undefined,
			undefined,
			runtime.ctx,
		),
		/sign in with \/login openai-codex/,
	);
	assert.equal(runtime.active().includes("research"), false);

	credential = { type: "oauth", accountId: "account" };
	await runtime.emit("before_agent_start");
	assert.equal(runtime.active().includes("research"), true);
});

test("login refresh registers the schema; logout removes it from subsequent payloads", async () => {
	let credential: Record<string, unknown> | undefined;
	const runtime = harness({ credential: () => credential });
	await runtime.emit("session_start");
	credential = { type: "oauth", accountId: "account" };
	await runtime.command("refresh");
	assert.equal(runtime.tools.has("research"), true);
	assert.equal(
		runtime
			.captureProviderRequest()
			.tools.some((tool) => tool.name === "research"),
		true,
	);

	credential = undefined;
	await runtime.emit("before_agent_start");
	const payload = runtime.captureProviderRequest();
	assert.equal(
		payload.tools.some((tool) => tool.name === "research"),
		false,
	);
	assert.equal(JSON.stringify(payload).includes(TOOL_DESCRIPTION), false);
	assert.ok(runtime.active().includes("read"));
	assert.ok(runtime.active().includes("other_tool"));

	const stale = runtime.tools.get("research");
	assert.ok(stale);
	await assert.rejects(
		stale.execute("stale", { query: "q" }, undefined, undefined, runtime.ctx),
		/Research unavailable/,
	);
});

test("ordinary checks preserve intentional user deactivation; explicit refresh enables", async () => {
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
	});
	await runtime.emit("session_start");
	runtime.setActive(["read", "other_tool"]);
	await runtime.emit("before_agent_start");
	assert.equal(runtime.active().includes("research"), false);
	await runtime.command("refresh");
	assert.equal(runtime.active().includes("research"), true);
});

test("backend denial deactivates until explicit refresh and preserves unrelated tools", async () => {
	const client = backend({
		selectModel: async () => "model",
		runResearch: async () => {
			throw new ResearchError("access_denied", "denied", false);
		},
	});
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		client,
	});
	await runtime.emit("session_start");
	const tool = runtime.tools.get("research");
	assert.ok(tool);
	await assert.rejects(
		tool.execute("call", { query: "q" }, undefined, undefined, runtime.ctx),
		ResearchError,
	);
	assert.equal(runtime.active().includes("research"), false);
	assert.ok(runtime.active().includes("other_tool"));
	await runtime.emit("before_agent_start");
	assert.equal(runtime.active().includes("research"), false);
	await runtime.command("refresh");
	assert.equal(runtime.active().includes("research"), true);
});

test("stale availability success cannot override a newer unavailable refresh", async () => {
	const oldSelection = deferred<string>();
	let selections = 0;
	const client = backend({
		selectModel: () => {
			selections += 1;
			return selections === 1
				? oldSelection.promise
				: Promise.reject(
						new ResearchError("client_outdated", "outdated", false),
					);
		},
	});
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		client,
	});
	const initialCheck = runtime.emit("session_start");
	while (selections < 1) await nextTurn();
	await runtime.command("refresh");
	assert.equal(runtime.active().includes("research"), false);
	oldSelection.resolve("model");
	await initialCheck;
	assert.equal(runtime.active().includes("research"), false);
});

test("a newer availability check aborts and cleans up its predecessor", async () => {
	const oldSelection = deferred<string>();
	let selections = 0;
	let oldSignal: AbortSignal | undefined;
	const client = backend({
		selectModel: (_auth: unknown, signal?: AbortSignal) => {
			selections += 1;
			if (selections === 1) {
				oldSignal = signal;
				return oldSelection.promise;
			}
			return Promise.resolve("model");
		},
	});
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		client,
	});
	const initialCheck = runtime.emit("session_start");
	while (!oldSignal) await nextTurn();

	await runtime.command("refresh");
	assert.equal(oldSignal.aborted, true);
	oldSelection.resolve("stale-model");
	await initialCheck;
	assert.equal(runtime.active().includes("research"), true);
});

test("session shutdown aborts and cleans up an active availability check", async () => {
	const selection = deferred<string>();
	let signal: AbortSignal | undefined;
	const client = backend({
		selectModel: (_auth: unknown, selectionSignal?: AbortSignal) => {
			signal = selectionSignal;
			return selection.promise;
		},
	});
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		client,
	});
	const initialCheck = runtime.emit("session_start");
	while (!signal) await nextTurn();

	await runtime.emit("session_shutdown");
	assert.equal(signal.aborted, true);
	selection.resolve("stale-model");
	await initialCheck;
	assert.equal(runtime.tools.has("research"), false);
	assert.equal(runtime.active().includes("research"), false);
});

test("availability requires a usable backend catalog before registering", async () => {
	const client = backend({
		selectModel: async () => {
			throw new ResearchError(
				"client_outdated",
				"catalog filtered by client version",
				false,
			);
		},
		runResearch: async () => {
			throw new Error("must not run");
		},
	});
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		client,
	});
	await runtime.emit("session_start");
	assert.equal(runtime.tools.has("research"), false);
	assert.equal(runtime.active().includes("research"), false);
	assert.match(runtime.notifications.at(-1) ?? "", /compatibility version/);
	await runtime.command("status");
	assert.match(runtime.notifications.at(-1) ?? "", /compatibility version/);
});

test("explicit refresh invalidates and rechecks the backend catalog", async () => {
	let invalidations = 0;
	let probes = 0;
	const client = backend({
		invalidateModel() {
			invalidations += 1;
		},
		selectModel: async () => {
			probes += 1;
			return "model";
		},
	});
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		client,
	});
	await runtime.emit("session_start");
	assert.equal(probes, 1);
	await runtime.command("refresh");
	assert.equal(invalidations, 1);
	assert.equal(probes, 2);
	assert.equal(runtime.active().includes("research"), true);
});

test("an old runResearch denial cannot disable a tool after refresh", async () => {
	const oldRun = deferred<CodexResearchResult>();
	let runs = 0;
	const client = backend({
		selectModel: async () => "model",
		runResearch: () => {
			runs += 1;
			return oldRun.promise;
		},
	});
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		client,
	});
	await runtime.emit("session_start");
	const tool = runtime.tools.get("research");
	assert.ok(tool);
	const execution = tool.execute(
		"old",
		{ query: "q" },
		undefined,
		undefined,
		runtime.ctx,
	);
	while (runs < 1) await nextTurn();
	await runtime.command("refresh");
	oldRun.reject(new ResearchError("access_denied", "denied", false));
	await assert.rejects(execution, ResearchError);
	assert.equal(runtime.active().includes("research"), true);
});

test("a new runResearch denial after refresh disables the tool", async () => {
	let runs = 0;
	const client = backend({
		selectModel: async () => "model",
		runResearch: async () => {
			runs += 1;
			throw new ResearchError("access_denied", "denied", false);
		},
	});
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		client,
	});
	await runtime.emit("session_start");
	await runtime.command("refresh");
	const tool = runtime.tools.get("research");
	assert.ok(tool);
	await assert.rejects(
		tool.execute("new", { query: "q" }, undefined, undefined, runtime.ctx),
		ResearchError,
	);
	assert.equal(runs, 1);
	assert.equal(runtime.active().includes("research"), false);
});

test("reload starts from fresh availability and unsupported Pi fails closed", async () => {
	const first = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
	});
	await first.emit("session_start");
	assert.equal(first.tools.has("research"), true);
	await first.emit("session_shutdown");

	const second = harness({ credential: () => undefined });
	await second.emit("session_start");
	assert.equal(second.tools.has("research"), false);

	// A host whose context lacks the model registry cannot resolve a token.
	// The extension must stay unregistered instead of throwing or guessing.
	let registered = false;
	let sessionStart: Handler | undefined;
	const api = partialFake<ResearchHost>({
		on(name: string, handler: Handler) {
			if (name === "session_start") sessionStart = handler;
			return () => {};
		},
		registerCommand() {},
		registerTool() {
			registered = true;
		},
		getActiveTools: () => ["read"],
		setActiveTools() {},
	});
	createResearchExtension({
		readCredential: () => ({
			type: "oauth",
			accountId: "account",
			access: "token",
			refresh: "r",
			expires: 1,
		}),
		client: backend({
			selectModel: async () => {
				throw new Error("must not reach the backend");
			},
		}),
	})(api);
	await sessionStart?.(
		{ type: "session_start" } as never,
		partialFake<ExtensionContext>({ mode: "tui", ui: { notify() {} } }),
	);
	assert.equal(registered, false);
});

test("status is read-only and unknown command arguments show usage", async () => {
	let tokenCalls = 0;
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		token: async () => {
			tokenCalls += 1;
			return "token";
		},
	});
	await runtime.emit("session_start");
	const afterStart = tokenCalls;
	await runtime.command("status");
	assert.equal(tokenCalls, afterStart);
	await runtime.command("wat");
	assert.match(runtime.notifications.at(-1) ?? "", /Usage:/);
});

test("repeated availability checks reuse the verified token", async () => {
	let tokenCalls = 0;
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		token: async () => {
			tokenCalls += 1;
			return "token";
		},
	});
	await runtime.emit("session_start");
	await runtime.emit("before_agent_start");
	await runtime.emit("before_agent_start");
	assert.equal(tokenCalls, 1);
	await runtime.command("refresh");
	assert.equal(tokenCalls, 2, "an explicit refresh always refreshes the token");
});

test("PI_EXT_DEBUG reports availability reason codes without secrets", async (t) => {
	const lines: string[] = [];
	const original = process.env.PI_EXT_DEBUG;
	process.env.PI_EXT_DEBUG = "other-package, codex-research-tool";
	t.mock.method(process.stderr, "write", (line: string) => {
		lines.push(line);
		return true;
	});
	t.after(() => {
		if (original === undefined) delete process.env.PI_EXT_DEBUG;
		else process.env.PI_EXT_DEBUG = original;
	});
	const runtime = harness({ credential: () => undefined });
	await runtime.emit("session_start");
	assert.deepEqual(lines, [
		"[codex-research-tool] availability:missing_oauth\n",
	]);
});
