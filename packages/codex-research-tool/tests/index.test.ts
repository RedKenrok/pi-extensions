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
	const result = await stale.execute(
		"stale",
		{ query: "q" },
		undefined,
		undefined,
		runtime.ctx,
	);
	assert.equal((result.details as { status: string }).status, "error");
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
	await tool.execute("call", { query: "q" }, undefined, undefined, runtime.ctx);
	assert.equal(runtime.active().includes("research"), false);
	assert.ok(runtime.active().includes("other_tool"));
	await runtime.emit("before_agent_start");
	assert.equal(runtime.active().includes("research"), false);
	await runtime.command("refresh");
	assert.equal(runtime.active().includes("research"), true);
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
