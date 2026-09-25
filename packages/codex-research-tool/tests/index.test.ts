import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createResearchExtension } from "../index.ts";
import { type CodexClient, ResearchError } from "../src/codex.ts";
import { TOOL_DESCRIPTION } from "../src/search.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function harness(options: {
	credential: () => Record<string, unknown> | undefined;
	token?: () => Promise<string | undefined>;
	client?: CodexClient;
}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<
		string,
		(args: string, ctx: ExtensionContext) => unknown
	>();
	const tools = new Map<string, ToolDefinition>();
	let active = ["read", "other_tool"];
	const notifications: string[] = [];
	const api = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(
			name: string,
			definition: { handler: (args: string, ctx: ExtensionContext) => unknown },
		) {
			commands.set(name, definition.handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
			active = [...new Set([...active, tool.name])];
		},
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = [...names];
		},
		getAllTools: () => [...tools.values()],
	} as unknown as ExtensionAPI;
	const ctx = {
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
	} as unknown as ExtensionContext;
	createResearchExtension({
		readCredential: () => options.credential() as never,
		resolveAccessToken: async () => (options.token ? options.token() : "token"),
		client:
			options.client ??
			({
				invalidateModel() {},
				selectModel: async () => "model",
				runResearch: async () => ({
					answer: "answer",
					citations: [],
					model: "model",
					searchActivity: 1,
				}),
			} as unknown as CodexClient),
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
				await handler({ type: name }, ctx);
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
	const client = {
		invalidateModel() {},
		selectModel: async () => "model",
		runResearch: async () => {
			throw new ResearchError("access_denied", "denied", false);
		},
	} as unknown as CodexClient;
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
	const client = {
		invalidateModel() {},
		selectModel: () => {
			selections += 1;
			return selections === 1
				? oldSelection.promise
				: Promise.reject(
						new ResearchError("client_outdated", "outdated", false),
					);
		},
		runResearch: async () => ({
			answer: "answer",
			citations: [],
			model: "model",
			searchActivity: 1,
		}),
	} as unknown as CodexClient;
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		client,
	});
	const initialCheck = runtime.emit("session_start");
	while (selections < 1) await new Promise((resolve) => setImmediate(resolve));
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
	const client = {
		invalidateModel() {},
		selectModel: (_auth: unknown, signal?: AbortSignal) => {
			selections += 1;
			if (selections === 1) {
				oldSignal = signal;
				return oldSelection.promise;
			}
			return Promise.resolve("model");
		},
		runResearch: async () => ({
			answer: "answer",
			citations: [],
			model: "model",
			searchActivity: 1,
		}),
	} as unknown as CodexClient;
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		client,
	});
	const initialCheck = runtime.emit("session_start");
	while (!oldSignal) await new Promise((resolve) => setImmediate(resolve));

	await runtime.command("refresh");
	assert.equal(oldSignal.aborted, true);
	oldSelection.resolve("stale-model");
	await initialCheck;
	assert.equal(runtime.active().includes("research"), true);
});

test("session shutdown aborts and cleans up an active availability check", async () => {
	const selection = deferred<string>();
	let signal: AbortSignal | undefined;
	const client = {
		invalidateModel() {},
		selectModel: (_auth: unknown, selectionSignal?: AbortSignal) => {
			signal = selectionSignal;
			return selection.promise;
		},
		runResearch: async () => ({
			answer: "answer",
			citations: [],
			model: "model",
			searchActivity: 1,
		}),
	} as unknown as CodexClient;
	const runtime = harness({
		credential: () => ({ type: "oauth", accountId: "account" }),
		client,
	});
	const initialCheck = runtime.emit("session_start");
	while (!signal) await new Promise((resolve) => setImmediate(resolve));

	await runtime.emit("session_shutdown");
	assert.equal(signal.aborted, true);
	selection.resolve("stale-model");
	await initialCheck;
	assert.equal(runtime.tools.has("research"), false);
	assert.equal(runtime.active().includes("research"), false);
});

test("availability requires a usable backend catalog before registering", async () => {
	const client = {
		invalidateModel() {},
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
	} as unknown as CodexClient;
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
	const client = {
		invalidateModel() {
			invalidations += 1;
		},
		selectModel: async () => {
			probes += 1;
			return "model";
		},
		runResearch: async () => ({
			answer: "answer",
			citations: [],
			model: "model",
			searchActivity: 1,
		}),
	} as unknown as CodexClient;
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
	const oldRun = deferred<{
		answer: string;
		citations: [];
		model: string;
		searchActivity: number;
	}>();
	let runs = 0;
	const client = {
		invalidateModel() {},
		selectModel: async () => "model",
		runResearch: () => {
			runs += 1;
			return oldRun.promise;
		},
	} as unknown as CodexClient;
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
	while (runs < 1) await new Promise((resolve) => setImmediate(resolve));
	await runtime.command("refresh");
	oldRun.reject(new ResearchError("access_denied", "denied", false));
	await assert.rejects(execution, ResearchError);
	assert.equal(runtime.active().includes("research"), true);
});

test("a new runResearch denial after refresh disables the tool", async () => {
	let runs = 0;
	const client = {
		invalidateModel() {},
		selectModel: async () => "model",
		runResearch: async () => {
			runs += 1;
			throw new ResearchError("access_denied", "denied", false);
		},
	} as unknown as CodexClient;
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

	let registered = false;
	const api = {
		on(name: string, handler: Handler) {
			if (name === "session_start") {
				void handler({ type: name }, second.ctx);
			}
		},
		registerCommand() {},
		registerTool() {
			registered = true;
		},
		getActiveTools: () => ["read"],
		setActiveTools() {},
	} as unknown as ExtensionAPI;
	createResearchExtension({
		readCredential: () => ({
			type: "oauth",
			accountId: "account",
			access: "token",
			refresh: "r",
			expires: 1,
		}),
	})(api);
	await new Promise((resolve) => setTimeout(resolve, 0));
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
