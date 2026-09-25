import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodexCompactionExtension } from "../index.ts";
import { accountFingerprint, CODEX_RESPONSES_URL } from "../src/remote.ts";

const PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const jwt = (account: string) =>
	`x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.y`;
const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.4",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	name: "Codex",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
};
const checkpoint = {
	version: 1,
	provider: "openai-codex",
	api: "openai-codex-responses",
	model: model.id,
	endpoint: CODEX_RESPONSES_URL,
	authMode: "oauth",
	accountFingerprint: accountFingerprint("acct"),
	item: { type: "compaction", encrypted_content: "secret" },
};

interface ReplayContext {
	model: typeof model;
	modelRegistry: {
		isUsingOAuth(): boolean;
		getApiKeyAndHeaders(): Promise<{
			ok: true;
			apiKey: string;
			baseUrl: string;
		}>;
	};
	sessionManager: { getBranch(): unknown[] };
}

function setup(
	details: unknown,
	tail: unknown[] = [],
	firstKeptEntryId = "compaction-1",
	before: unknown[] = [],
) {
	let replay:
		| ((event: { payload: unknown }, ctx: ReplayContext) => Promise<unknown>)
		| undefined;
	const pi = {
		on(name: string, handler: unknown) {
			if (name === "before_provider_request") replay = handler as typeof replay;
		},
	} as unknown as ExtensionAPI;
	createCodexCompactionExtension()(pi);
	const compaction = {
		type: "compaction",
		id: "compaction-1",
		firstKeptEntryId,
		summary: "readable",
		details,
	};
	const branch = [...before, compaction, ...tail];
	const ctx = {
		model,
		modelRegistry: {
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => ({
				ok: true as const,
				apiKey: jwt("acct"),
				baseUrl: "https://chatgpt.com/backend-api",
			}),
		},
		sessionManager: { getBranch: () => branch },
	};
	assert.ok(replay);
	return { replay, ctx };
}

test("replaces only the generated summary and preserves the converted tail byte-for-byte", async () => {
	const { replay, ctx } = setup({ remoteCompaction: checkpoint });
	const tail = {
		role: "user",
		content: [{ type: "input_text", text: "kept" }],
		providerSpecific: { x: 1 },
	};
	const payload = {
		model: model.id,
		previous_response_id: "remove",
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: `${PREFIX}readable\n</summary>` },
				],
			},
			tail,
		],
	};
	const result = (await replay({ payload }, ctx)) as Record<string, unknown>;
	assert.deepEqual(result.input, [checkpoint.item, tail]);
	assert.equal((result.input as unknown[])[1], tail);
	assert.equal("previous_response_id" in result, false);
});

test("latest malformed checkpoint blocks replay and an incompatible tail blocks replay", async () => {
	const malformed = setup({
		remoteCompaction: { ...checkpoint, item: { type: "message" } },
	});
	assert.equal(
		await malformed.replay(
			{
				payload: {
					model: model.id,
					input: [
						{ role: "user", content: [{ type: "input_text", text: PREFIX }] },
					],
				},
			},
			malformed.ctx,
		),
		undefined,
	);
	const switched = setup({ remoteCompaction: checkpoint }, [
		{
			type: "message",
			message: {
				role: "assistant",
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: "other",
			},
		},
	]);
	assert.equal(
		await switched.replay(
			{
				payload: {
					model: model.id,
					input: [
						{ role: "user", content: [{ type: "input_text", text: PREFIX }] },
					],
				},
			},
			switched.ctx,
		),
		undefined,
	);
});

test("payload model must match the active model before replay", async () => {
	const state = setup({ remoteCompaction: checkpoint });
	const summary = {
		role: "user",
		content: [{ type: "input_text", text: `${PREFIX}readable\\n</summary>` }],
	};
	assert.equal(
		await state.replay(
			{ payload: { model: "other-model", input: [summary] } },
			state.ctx,
		),
		undefined,
	);
});

test("a retain-none compaction may use its own id as the kept boundary", async () => {
	const state = setup({ remoteCompaction: checkpoint });
	const result = (await state.replay(
		{
			payload: {
				model: model.id,
				input: [
					{
						role: "user",
						content: [
							{ type: "input_text", text: `${PREFIX}readable\n</summary>` },
						],
					},
				],
			},
		},
		state.ctx,
	)) as Record<string, unknown>;
	assert.deepEqual(result.input, [checkpoint.item]);
});

test("duplicate kept-boundary ids fail closed", async () => {
	const duplicate = { type: "message", id: "kept-1" };
	const state = setup({ remoteCompaction: checkpoint }, [], "kept-1", [
		duplicate,
		{ ...duplicate },
	]);
	assert.equal(
		await state.replay(
			{
				payload: {
					model: model.id,
					input: [
						{ role: "user", content: [{ type: "input_text", text: PREFIX }] },
					],
				},
			},
			state.ctx,
		),
		undefined,
	);
});

test("retained entries before the compaction are part of replay validation", async () => {
	const kept = {
		type: "message",
		id: "kept-1",
		message: {
			role: "assistant",
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "other",
		},
	};
	const state = setup({ remoteCompaction: checkpoint }, [], "kept-1", [kept]);
	assert.equal(
		await state.replay(
			{
				payload: {
					model: model.id,
					input: [
						{ role: "user", content: [{ type: "input_text", text: PREFIX }] },
					],
				},
			},
			state.ctx,
		),
		undefined,
	);
});

test("account mismatch and ambiguous summary matches leave payload untouched", async () => {
	const state = setup({
		remoteCompaction: {
			...checkpoint,
			accountFingerprint: accountFingerprint("other"),
		},
	});
	assert.equal(
		await state.replay(
			{
				payload: {
					model: model.id,
					input: [
						{ role: "user", content: [{ type: "input_text", text: PREFIX }] },
					],
				},
			},
			state.ctx,
		),
		undefined,
	);
	const valid = setup({ remoteCompaction: checkpoint });
	const summary = {
		role: "user",
		content: [{ type: "input_text", text: `${PREFIX}readable\n</summary>` }],
	};
	assert.equal(
		await valid.replay(
			{ payload: { model: model.id, input: [summary, summary] } },
			valid.ctx,
		),
		undefined,
	);
	const augmented = {
		...summary,
		content: [
			...summary.content,
			{ type: "input_text", text: "context added by another extension" },
		],
	};
	assert.equal(
		await valid.replay(
			{ payload: { model: model.id, input: [augmented] } },
			valid.ctx,
		),
		undefined,
	);
});
