import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactTool } from "../../compact-tool/src/compact.ts";
import { createCodexCompactionExtension } from "../index.ts";
import { CODEX_RESPONSES_URL } from "../src/remote.ts";

const jwt = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.y`;
const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.4",
	name: "Codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
};
const user = (text: string) => ({
	role: "user" as const,
	content: text,
	timestamp: 1,
});

function fixture(options: { remoteFails?: boolean; previous?: boolean } = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	let sentBody: any;
	let nativePreparation: any;
	const previousItem = { type: "compaction", encrypted_content: "previous" };
	const prior = options.previous
		? {
				type: "compaction",
				summary: "old",
				details: {
					readFiles: ["old-read.ts"],
					modifiedFiles: ["old-write.ts"],
					remoteCompaction: {
						version: 1,
						provider: "openai-codex",
						api: "openai-codex-responses",
						model: model.id,
						endpoint: CODEX_RESPONSES_URL,
						authMode: "oauth",
						accountFingerprint: "3vCxf2Ayhe9DNvbj49zUPNGP14knernW4Ia35WdTniU",
						item: previousItem,
					},
				},
			}
		: undefined;
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
			handlers.set(name, handler);
		},
		getActiveTools: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	createCodexCompactionExtension({
		nativeCompact: (async (preparation: any) => {
			nativePreparation = preparation;
			return {
				summary: "portable",
				firstKeptEntryId: "kept",
				tokensBefore: 10,
				details: { readFiles: ["new.ts"], modifiedFiles: [] },
			};
		}) as any,
		fetch: async (_url, init) => {
			sentBody = JSON.parse(String(init?.body));
			if (options.remoteFails) return new Response("failure", { status: 500 });
			return new Response(
				`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "compaction", encrypted_content: "new" }] } })}\n\n`,
				{ status: 200 },
			);
		},
	})(pi);
	const ctx = {
		model,
		thinkingLevel: "low",
		getSystemPrompt: () => "system",
		modelRegistry: {
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: jwt,
				baseUrl: "https://chatgpt.com/backend-api",
			}),
		},
	};
	const preparation = {
		firstKeptEntryId: "kept",
		messagesToSummarize: [user("discarded")],
		turnPrefixMessages: [user("split-prefix")],
		isSplitTurn: true,
		tokensBefore: 10,
		previousSummary: options.previous ? "old" : undefined,
		fileOps: {
			read: new Set(["new.ts"]),
			written: new Set<string>(),
			edited: new Set<string>(),
		},
		settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
	};
	return {
		handler: handlers.get("session_before_compact")!,
		ctx,
		preparation,
		prior,
		getBody: () => sentBody,
		getNative: () => nativePreparation,
	};
}

test("hybrid compacts only discarded prefix plus split prefix and keeps portable summary", async () => {
	const state = fixture();
	const result = await state.handler(
		{
			preparation: state.preparation,
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		},
		state.ctx,
	);
	assert.equal(result.compaction.summary, "portable");
	assert.equal(
		result.compaction.details.remoteCompaction.item.encrypted_content,
		"new",
	);
	const input = state.getBody().input;
	assert.match(JSON.stringify(input), /discarded/);
	assert.match(JSON.stringify(input), /split-prefix/);
	assert.doesNotMatch(JSON.stringify(input), /kept-tail/);
	assert.deepEqual(input.at(-1), { type: "compaction_trigger" });
});

test("successive compaction seeds prior checkpoint and merges cumulative file operations", async () => {
	const state = fixture({ previous: true });
	await state.handler(
		{
			preparation: state.preparation,
			branchEntries: [state.prior],
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		},
		state.ctx,
	);
	assert.equal(state.getBody().input[0].encrypted_content, "previous");
	assert.equal(state.getNative().fileOps.read.has("old-read.ts"), true);
	assert.equal(state.getNative().fileOps.edited.has("old-write.ts"), true);
});

test("remote failure retains native result and custom instructions delegate entirely to Pi", async () => {
	const state = fixture({ remoteFails: true });
	const result = await state.handler(
		{
			preparation: state.preparation,
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		},
		state.ctx,
	);
	assert.equal(result.compaction.summary, "portable");
	assert.equal(result.compaction.details.remoteCompaction, undefined);
	assert.equal(
		await state.handler(
			{
				preparation: state.preparation,
				branchEntries: [],
				customInstructions: "focus",
				reason: "manual",
				willRetry: false,
				signal: new AbortController().signal,
			},
			state.ctx,
		),
		undefined,
	);

	const afterHybrid = fixture({ previous: true });
	assert.equal(
		await afterHybrid.handler(
			{
				preparation: afterHybrid.preparation,
				branchEntries: [afterHybrid.prior],
				customInstructions: "native boundary",
				reason: "manual",
				willRetry: false,
				signal: new AbortController().signal,
			},
			afterHybrid.ctx,
		),
		undefined,
	);
	assert.equal(afterHybrid.preparation.fileOps.read.has("old-read.ts"), true);
	assert.equal(
		afterHybrid.preparation.fileOps.edited.has("old-write.ts"),
		true,
	);
});

test("compact-tool coexists and forwards instructions into the same Pi compaction lifecycle", async () => {
	let tool: any;
	const pi = {
		registerTool(value: any) {
			tool = value;
		},
	} as ExtensionAPI;
	registerCompactTool(pi);
	let options: any;
	await tool.execute("id", { instructions: "focus" }, undefined, undefined, {
		compact(value: any) {
			options = value;
		},
		isIdle: () => false,
		hasPendingMessages: () => false,
		hasUI: false,
	});
	assert.equal(options.customInstructions, "focus");
	const state = fixture();
	assert.equal(
		await state.handler(
			{
				preparation: state.preparation,
				branchEntries: [],
				customInstructions: options.customInstructions,
				reason: "manual",
				willRetry: false,
				signal: new AbortController().signal,
			},
			state.ctx,
		),
		undefined,
	);
});
