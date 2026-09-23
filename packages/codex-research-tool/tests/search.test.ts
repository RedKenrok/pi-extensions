import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AuthResult } from "../src/auth.ts";
import { type CodexClient, ResearchError } from "../src/codex.ts";
import {
	createResearchTool,
	formatError,
	formatSuccess,
	MAX_RESULT_CHARS,
	RESEARCH_DEADLINE_MS,
	TOOL_DESCRIPTION,
	TOOL_NAME,
} from "../src/search.ts";

const auth: Extract<AuthResult, { kind: "ready" }> = {
	kind: "ready",
	accessToken: "dummy",
	accountId: "account",
};

const context = {
	model: { provider: "other", id: "conversation-model" },
} as unknown as ExtensionContext;

function fakeClient(overrides: Partial<CodexClient> = {}): CodexClient {
	return {
		selectModel: async () => "research-model",
		runResearch: async () => ({
			answer: "answer",
			citations: [],
			model: "research-model",
			searchActivity: 1,
		}),
		...overrides,
	} as CodexClient;
}

test("exposes only the exact v1 research contract", () => {
	const tool = createResearchTool({
		authCheck: async () => auth,
		client: fakeClient(),
		onUnavailable() {},
	});
	assert.equal(tool.name, TOOL_NAME);
	assert.equal(tool.name, "research");
	assert.equal(RESEARCH_DEADLINE_MS, 10 * 60_000);
	assert.notEqual(tool.name, "codex_search");
	assert.equal(tool.label, "Research");
	assert.equal(tool.description, TOOL_DESCRIPTION);
	const schema = tool.parameters as unknown as Record<string, unknown>;
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(schema.required, ["query"]);
	const query = (schema.properties as Record<string, Record<string, unknown>>)
		.query;
	const model = (schema.properties as Record<string, Record<string, unknown>>)
		.model;
	const effort = (schema.properties as Record<string, Record<string, unknown>>)
		.effort;
	assert.equal(query?.minLength, 1);
	assert.equal(query?.maxLength, 4000);
	assert.equal(model?.minLength, 1);
	assert.equal(model?.maxLength, 128);
	assert.equal(effort?.minLength, 1);
	assert.equal(effort?.maxLength, 32);
});

test("passes an exact per-call model override through catalog validation", async () => {
	let requested: string | undefined;
	let requestedEffort: string | undefined;
	let sentModel = "";
	const client = fakeClient({
		selectModel: async (_auth, _signal, requestedModel, effort) => {
			requested = requestedModel;
			requestedEffort = effort;
			return requestedModel ?? "gpt-6-luna";
		},
		runResearch: async (options) => {
			sentModel = options.model;
			return {
				answer: "answer",
				citations: [],
				model: options.model,
				...(options.effort ? { effort: options.effort } : {}),
				searchActivity: 1,
			};
		},
	});
	const tool = createResearchTool({
		authCheck: async () => auth,
		client,
		onUnavailable() {},
	});
	const result = await tool.execute(
		"call",
		{ query: "question", model: "gpt-custom", effort: "high" },
		undefined,
		undefined,
		context,
	);
	assert.equal(requested, "gpt-custom");
	assert.equal(requestedEffort, "high");
	assert.equal(sentModel, "gpt-custom");
	assert.equal(result.details.model, "gpt-custom");
	assert.equal(result.details.effort, "high");
	assert.match(
		result.content[0]?.type === "text" ? result.content[0].text : "",
		/Reasoning effort: high/,
	);
});

test("trims input without rewriting it and uses a non-Codex conversation model independently", async () => {
	let selected = false;
	let sentQuery = "";
	const client = fakeClient({
		selectModel: async () => {
			selected = true;
			return "gpt-6-luna";
		},
		runResearch: async (options) => {
			sentQuery = options.query;
			return {
				answer: "answer",
				citations: [],
				model: options.model,
				searchActivity: 1,
			};
		},
	});
	const tool = createResearchTool({
		authCheck: async () => auth,
		client,
		onUnavailable() {},
	});
	const result = await tool.execute(
		"call",
		{ query: "  exact question  " },
		undefined,
		undefined,
		context,
	);
	assert.equal(sentQuery, "exact question");
	assert.equal(selected, true);
	assert.equal(result.details.model, "gpt-6-luna");
});

test("rejects empty and overlong input before auth or transport", async (t) => {
	let authCalls = 0;
	const tool = createResearchTool({
		authCheck: async () => {
			authCalls += 1;
			return auth;
		},
		client: fakeClient(),
		onUnavailable() {},
	});
	for (const query of ["   ", "x".repeat(4001)]) {
		await t.test(String(query.length), async () => {
			const result = await tool.execute(
				"call",
				{ query },
				undefined,
				undefined,
				context,
			);
			assert.equal(result.details.status, "error");
			assert.equal(result.details.error?.code, "invalid_input");
		});
	}
	assert.equal(authCalls, 0);
});

test("rejects invalid model and effort values before authentication", async () => {
	let authCalls = 0;
	const tool = createResearchTool({
		authCheck: async () => {
			authCalls += 1;
			return auth;
		},
		client: fakeClient(),
		onUnavailable() {},
	});
	const result = await tool.execute(
		"call",
		{ query: "question", model: "   " },
		undefined,
		undefined,
		context,
	);
	assert.equal(result.details.error?.code, "invalid_input");
	const effortResult = await tool.execute(
		"call-effort",
		{ query: "question", effort: "   " },
		undefined,
		undefined,
		context,
	);
	assert.equal(effortResult.details.error?.code, "invalid_input");
	assert.equal(authCalls, 0);
});

test("returns catalog model and reasoning options for an unavailable choice", async () => {
	const options = [
		{ id: "gpt-a", efforts: ["low", "high"], defaultEffort: "high" },
		{ id: "gpt-b", efforts: ["medium"] },
	];
	const tool = createResearchTool({
		authCheck: async () => auth,
		client: fakeClient({
			selectModel: async () => {
				throw new ResearchError(
					"invalid_input",
					"Requested choice is unavailable. Available models and reasoning levels:\n- gpt-a: low, high (default)\n- gpt-b: medium",
					false,
					undefined,
					options,
				);
			},
		}),
		onUnavailable() {},
	});
	const result = await tool.execute(
		"call",
		{ query: "question", model: "missing", effort: "xhigh" },
		undefined,
		undefined,
		context,
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(text, /gpt-a: low, high \(default\)/);
	assert.deepEqual(result.details.error?.modelOptions, options);
});

test("returns an explicit uncited warning", () => {
	const result = formatSuccess(
		"q",
		{
			answer: "Unverified answer",
			citations: [],
			model: "m",
			searchActivity: 1,
		},
		10,
	);
	assert.equal(result.details.status, "uncited");
	assert.match(
		result.content[0]?.type === "text" ? result.content[0].text : "",
		/not source-verified/,
	);
});

test("filters unsafe links, deduplicates URLs, and preserves claim markers", () => {
	const answer = "Claim one. Claim two.";
	const result = formatSuccess(
		"q",
		{
			answer,
			citations: [
				{
					title: "One",
					url: "https://example.com/one",
					startIndex: 0,
					endIndex: 10,
				},
				{ title: "Duplicate", url: "https://example.com/one" },
				{
					title: "Unsafe",
					url: "javascript:alert(1)",
					startIndex: 0,
					endIndex: 10,
				},
			],
			model: "m",
			searchActivity: 1,
		},
		10,
	);
	assert.equal(result.details.sources.length, 1);
	assert.match(result.details.answer ?? "", /Claim one\. \[1\]/);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.equal(text.includes("javascript:"), false);
});

test("caps both public text and metadata answer", () => {
	const result = formatSuccess(
		"q",
		{
			answer: "x".repeat(40_000),
			citations: Array.from({ length: 200 }, (_, index) => ({
				title: `Source ${index}`,
				url: `https://example.com/${index}`,
			})),
			model: "m",
			searchActivity: 1,
		},
		10,
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.ok(text.length <= MAX_RESULT_CHARS);
	assert.ok((result.details.answer?.length ?? 0) <= MAX_RESULT_CHARS);
	assert.equal(result.details.truncated, true);
	assert.match(text, /Result truncated/);
});

test("collapsed and expanded TUI renderers keep the result contract readable", () => {
	const tool = createResearchTool({
		authCheck: async () => auth,
		client: fakeClient(),
		onUnavailable() {},
	});
	const result = formatSuccess(
		"q",
		{
			answer: "A complete rendered answer.",
			citations: [{ title: "Source", url: "https://example.com/source" }],
			model: "m",
			searchActivity: 1,
		},
		10,
	);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const collapsed = tool.renderResult?.(
		result,
		{ expanded: false, isPartial: false },
		theme as never,
		{} as never,
	);
	const expanded = tool.renderResult?.(
		result,
		{ expanded: true, isPartial: false },
		theme as never,
		{} as never,
	);
	assert.match(collapsed?.render(500).join("\n") ?? "", /1 source/);
	assert.match(
		expanded?.render(500).join("\n") ?? "",
		/A complete rendered answer/,
	);
});

test("auth loss disables before any backend request and errors are explicit", async () => {
	let transportCalls = 0;
	let disabled = false;
	const tool = createResearchTool({
		authCheck: async () => ({
			kind: "unavailable",
			reason: "missing_oauth",
			message: "Research unavailable: sign in.",
		}),
		client: fakeClient({
			runResearch: async () => {
				transportCalls += 1;
				throw new Error("should not run");
			},
		}),
		onUnavailable() {
			disabled = true;
		},
	});
	const result = await tool.execute(
		"call",
		{ query: "q" },
		undefined,
		undefined,
		context,
	);
	assert.equal(transportCalls, 0);
	assert.equal(disabled, true);
	assert.equal(result.details.status, "error");
	assert.match(
		result.content[0]?.type === "text" ? result.content[0].text : "",
		/Status: error/,
	);
});

test("backend compatibility failures deactivate while rate limits remain active", async (t) => {
	for (const [code, expectedDisabled] of [
		["access_denied", true],
		["client_outdated", true],
		["rate_limited", false],
	] as const) {
		await t.test(code, async () => {
			let disabled = false;
			const tool = createResearchTool({
				authCheck: async () => auth,
				client: fakeClient({
					runResearch: async () => {
						throw new ResearchError(code, "sanitized", code === "rate_limited");
					},
				}),
				onUnavailable() {
					disabled = true;
				},
			});
			const result = await tool.execute(
				"call",
				{ query: "q" },
				undefined,
				undefined,
				context,
			);
			assert.equal(disabled, expectedDisabled);
			assert.equal(result.details.error?.code, code);
		});
	}
});

test("Pi cancellation produces a controlled cancelled result", async () => {
	const controller = new AbortController();
	const tool = createResearchTool({
		authCheck: async () => auth,
		client: fakeClient({
			runResearch: async (options) =>
				new Promise((_resolve, reject) => {
					if (options.signal?.aborted) {
						reject(
							new ResearchError("cancelled", "Research was cancelled.", false),
						);
						return;
					}
					options.signal?.addEventListener("abort", () =>
						reject(
							new ResearchError("cancelled", "Research was cancelled.", false),
						),
					);
				}),
		}),
		onUnavailable() {},
	});
	const pending = tool.execute(
		"call",
		{ query: "q" },
		controller.signal,
		undefined,
		context,
	);
	controller.abort();
	const result = await pending;
	assert.equal(result.details.error?.code, "cancelled");
});

test("the total deadline produces a controlled timeout", async () => {
	const tool = createResearchTool({
		authCheck: async () => auth,
		deadlineMs: 5,
		client: fakeClient({
			runResearch: async (options) =>
				new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () =>
						reject(new DOMException("timed out", "AbortError")),
					);
				}),
		}),
		onUnavailable() {},
	});
	const result = await tool.execute(
		"call",
		{ query: "q" },
		undefined,
		undefined,
		context,
	);
	assert.equal(result.details.error?.code, "timeout");
});

test("failure content is sanitized and structured", () => {
	const result = formatError(
		"q",
		new ResearchError("network", "Safe message", true, 3),
		12,
		false,
	);
	assert.equal(result.details.error?.retryAfterSeconds, 3);
	assert.match(
		result.content[0]?.type === "text" ? result.content[0].text : "",
		/^Status: error/,
	);
});
