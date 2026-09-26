import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { deferred } from "../../../test-support/async.ts";
import { jwt as token } from "../../../test-support/jwt.ts";
import { chunkedResponse } from "../../../test-support/streams.ts";
import {
	accountFingerprint,
	accountIdFromToken,
	BETA_FEATURE,
	buildCheckpoint,
	CODEX_RESPONSES_URL,
	captureCodexInput,
	isTrustedModel,
	MAX_FRAME_BYTES,
	MAX_STREAM_BYTES,
	mergedHeaders,
	parseCheckpoint,
	requestRemoteCompaction,
} from "../src/remote.ts";

const model = {
	id: "gpt-5.4",
	name: "Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
} satisfies Model<"openai-codex-responses">;

test("extracts and hashes the OAuth account without retaining the token", () => {
	assert.equal(accountIdFromToken(token("acct-1")), "acct-1");
	assert.equal(accountIdFromToken("bad"), undefined);
	const [header, payload] = token("acct-1").split(".");
	assert.equal(accountIdFromToken(`${header}.${payload}`), undefined);
	assert.equal(accountIdFromToken(`${token("acct-1")}.extra`), undefined);
	assert.equal(accountFingerprint("acct-1"), accountFingerprint("acct-1"));
	assert.notEqual(accountFingerprint("acct-1"), accountFingerprint("acct-2"));
});

test("only accepts the fixed Codex provider/API/endpoint", () => {
	assert.equal(isTrustedModel(model), true);
	assert.equal(
		isTrustedModel({ ...model, baseUrl: "https://evil.example/backend-api" }),
		false,
	);
	assert.equal(isTrustedModel({ ...model, provider: "openai" }), false);
	assert.equal(
		isTrustedModel({
			...model,
			baseUrl: "https://user@chatgpt.com/backend-api",
		}),
		false,
	);
	assert.equal(
		isTrustedModel({
			...model,
			baseUrl: "https://chatgpt.com/backend-api?proxy=1",
		}),
		false,
	);
});

test("captures SDK Responses conversion before transport", async () => {
	const captured = await captureCodexInput(
		model,
		[{ role: "user", content: "hello", timestamp: 1 }],
		token("acct"),
	);
	assert.equal(captured.input.length, 1);
	assert.deepEqual(captured.input[0], {
		role: "user",
		content: [{ type: "input_text", text: "hello" }],
	});
	assert.equal(captured.template.stream, true);
});

test("sends trailing trigger, required beta, and accepts exactly one completed checkpoint", async () => {
	let request: RequestInit | undefined;
	const checkpoint = { type: "compaction", encrypted_content: "opaque" };
	const result = await requestRemoteCompaction(
		{ model: model.id, reasoning: { effort: "low" }, stream: true },
		[{ type: "message", role: "user", content: [] }],
		{ accessToken: token("acct"), accountId: "acct" },
		{
			headers: {
				"X-Provider-Region": "custom",
				Authorization: "evil",
				Origin: "https://evil.example",
				"X-API-Key": "stolen",
			},
			fetch: async (input, init) => {
				assert.equal(input, CODEX_RESPONSES_URL);
				request = init;
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [checkpoint] } })}\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			},
		},
	);
	assert.deepEqual(result, checkpoint);
	assert.equal(request?.redirect, "manual");
	const headers = new Headers(request?.headers);
	assert.equal(headers.get("x-codex-beta-features"), BETA_FEATURE);
	assert.equal(headers.get("chatgpt-account-id"), "acct");
	assert.equal(headers.get("x-provider-region"), "custom");
	assert.equal(headers.get("authorization"), `Bearer ${token("acct")}`);
	assert.equal(headers.get("origin"), null);
	assert.equal(headers.get("x-api-key"), null);
	const body = JSON.parse(String(request?.body)) as {
		input: unknown[];
		reasoning: unknown;
	};
	assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });
	assert.deepEqual(body.reasoning, { effort: "low" });
});

test("abort promptly rejects fetches that ignore cancellation while awaiting headers", async () => {
	const controller = new AbortController();
	const started = deferred<void>();
	const request = requestRemoteCompaction(
		{ model: model.id },
		[],
		{ accessToken: token("acct"), accountId: "acct" },
		{
			timeoutMs: 1_000,
			signal: controller.signal,
			fetch: async () => {
				started.resolve();
				return new Promise<Response>(() => {});
			},
		},
	);
	await started.promise;
	controller.abort(new DOMException("cancelled", "AbortError"));
	await assert.rejects(request, { name: "AbortError" });
});

test("pre-aborted signal prevents starting fetch", async () => {
	const controller = new AbortController();
	controller.abort(new DOMException("cancelled", "AbortError"));
	let called = false;
	await assert.rejects(
		requestRemoteCompaction(
			{},
			[],
			{ accessToken: "x", accountId: "a" },
			{
				signal: controller.signal,
				fetch: async () => {
					called = true;
					return new Response();
				},
			},
		),
	);
	assert.equal(called, false);
});

test("cancels rejected HTTP response bodies", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	await assert.rejects(
		requestRemoteCompaction(
			{},
			[],
			{ accessToken: "x", accountId: "a" },
			{ fetch: async () => new Response(body, { status: 500 }) },
		),
	);
	assert.equal(cancelled, true);
});

test("rejects unbounded and non-finite timeout values", async () => {
	for (const timeoutMs of [NaN, Infinity, 0, 601_000])
		await assert.rejects(
			requestRemoteCompaction(
				{},
				[],
				{ accessToken: "x", accountId: "a" },
				{ timeoutMs, fetch: fetch },
			),
		);
});

test("rejects redirects, malformed SSE, missing completion, and ambiguous checkpoints", async (t) => {
	const run = (response: Response) =>
		requestRemoteCompaction(
			{ model: model.id },
			[],
			{ accessToken: token("acct"), accountId: "acct" },
			{ fetch: async () => response },
		);
	await t.test("redirect", async () =>
		assert.rejects(run(new Response(null, { status: 302 }))),
	);
	await t.test("malformed", async () =>
		assert.rejects(run(new Response("data: {no}\n\n", { status: 200 }))),
	);
	await t.test("no terminal", async () =>
		assert.rejects(run(new Response("data: {}\n\n", { status: 200 }))),
	);
	await t.test("two checkpoints", async () =>
		assert.rejects(
			run(
				new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "compaction" }, { type: "compaction" }] } })}\n\n`,
					{ status: 200 },
				),
			),
		),
	);
});

test("accepts item.done checkpoints, terminal duplication, split chunks, final frames, and cancels after completion", async () => {
	const checkpoint = { type: "compaction", encrypted_content: "opaque" };
	const reordered = { encrypted_content: "opaque", type: "compaction" };
	const itemDone = `data: ${JSON.stringify({ type: "response.output_item.done", item: checkpoint })}\n\n`;
	const completed = `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [reordered] } })}`;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const bytes = new TextEncoder().encode(`${itemDone}${completed}\n\n`);
			controller.enqueue(bytes.slice(0, 17));
			controller.enqueue(bytes.slice(17));
			// Deliberately never close: completion must cancel immediately.
		},
		cancel() {
			cancelled = true;
		},
	});
	const result = await requestRemoteCompaction(
		{ model: model.id },
		[],
		{ accessToken: token("acct"), accountId: "acct" },
		{
			timeoutMs: 1_000,
			fetch: async () => new Response(stream, { status: 200 }),
		},
	);
	assert.deepEqual(result, checkpoint);
	assert.equal(cancelled, true);

	const duplicate = new Response(
		`${itemDone}data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [checkpoint] } })}`,
		{ status: 200 },
	);
	assert.deepEqual(
		await requestRemoteCompaction(
			{ model: model.id },
			[],
			{ accessToken: token("acct"), accountId: "acct" },
			{ fetch: async () => duplicate },
		),
		checkpoint,
	);
});

test("rejects conflicting streamed and terminal checkpoints", async () => {
	const first = { type: "compaction", encrypted_content: "one" };
	const second = { type: "compaction", encrypted_content: "two" };
	const body = `data: ${JSON.stringify({ type: "response.output_item.done", item: first })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [second] } })}\n\n`;
	await assert.rejects(
		requestRemoteCompaction(
			{ model: model.id },
			[],
			{ accessToken: token("acct"), accountId: "acct" },
			{ fetch: async () => new Response(body, { status: 200 }) },
		),
	);
});

test("does not return a checkpoint when cancellation races terminal SSE", async () => {
	const controller = new AbortController();
	const terminal = `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "compaction", encrypted_content: "opaque" }] } })}\n\n`;
	let cancelled = false;
	const makeStream = () =>
		new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(new TextEncoder().encode(terminal));
				controller.abort(new DOMException("cancelled", "AbortError"));
			},
			cancel() {
				cancelled = true;
			},
		});
	await assert.rejects(
		requestRemoteCompaction(
			{ model: model.id },
			[],
			{ accessToken: token("acct"), accountId: "acct" },
			{
				signal: controller.signal,
				fetch: async () => new Response(makeStream(), { status: 200 }),
			},
		),
	);
	assert.equal(cancelled, true);
});

test("checkpoint validation rejects malformed and mismatched metadata", () => {
	const valid = {
		version: 1,
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.4",
		endpoint: CODEX_RESPONSES_URL,
		authMode: "oauth",
		accountFingerprint: "hash",
		item: { type: "compaction", encrypted_content: "opaque" },
	};
	assert.deepEqual(parseCheckpoint(valid), valid);
	assert.equal(
		parseCheckpoint({ ...valid, endpoint: "https://evil.example" }),
		undefined,
	);
	assert.equal(
		parseCheckpoint({ ...valid, item: { type: "message" } }),
		undefined,
	);
});

const completedFrame = (
	output: unknown[],
	extra: Record<string, unknown> = {},
) =>
	`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, ...extra } })}\n\n`;
const opaque = { type: "compaction", encrypted_content: "opaque" };
const authPair = { accessToken: token("acct"), accountId: "acct" };

test("resolver headers cannot override credentials, routing, or framing", () => {
	const headers = mergedHeaders(
		{
			Authorization: "Bearer stolen",
			"X-Api-Key": "stolen",
			"X-Session-Token": "stolen",
			Host: "evil.example",
			"Transfer-Encoding": "chunked",
			"X-Forwarded-For": "1.2.3.4",
			"ChatGPT-Account-ID": "other",
			"Content-Type": "text/plain",
			"x-codex-beta-features": "other",
			[`X-${"n".repeat(130)}`]: "long name",
			"X-Long-Value": "v".repeat(8193),
			"X-Feature": "kept",
		},
		authPair,
	);
	assert.equal(headers.get("authorization"), `Bearer ${authPair.accessToken}`);
	assert.equal(headers.get("chatgpt-account-id"), "acct");
	assert.equal(headers.get("content-type"), "application/json");
	assert.equal(headers.get("x-codex-beta-features"), BETA_FEATURE);
	assert.equal(headers.get("x-feature"), "kept");
	for (const name of [
		"x-api-key",
		"x-session-token",
		"host",
		"transfer-encoding",
		"x-forwarded-for",
		"x-long-value",
	])
		assert.equal(headers.has(name), false, name);
	assert.equal(
		[...headers.keys()].some((name) => name.length > 128),
		false,
	);
	const many = Object.fromEntries(
		Array.from({ length: 65 }, (_, index) => [`X-Feature-${index}`, "1"]),
	);
	assert.throws(() => mergedHeaders(many, authPair), /Too many/);
});

test("a response that arrives after cancellation has its body released", async () => {
	const controller = new AbortController();
	const late = deferred<Response>();
	const fetchStarted = deferred<void>();
	let cancelled = false;
	const request = requestRemoteCompaction({}, [], authPair, {
		signal: controller.signal,
		fetch: async () => {
			fetchStarted.resolve();
			return late.promise;
		},
	});
	await fetchStarted.promise;
	controller.abort(new DOMException("cancelled", "AbortError"));
	await assert.rejects(request, { name: "AbortError" });
	late.resolve(
		new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 200 },
		),
	);
	await late.promise;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(cancelled, true);
});

test("reports bounded usage from the completed response", async () => {
	const usage = { input_tokens: 5 };
	let reported: unknown;
	const item = await requestRemoteCompaction({}, [], authPair, {
		fetch: async () =>
			new Response(completedFrame([opaque], { usage }), { status: 200 }),
		onUsage: (value) => {
			reported = value;
		},
	});
	assert.deepEqual(item, opaque);
	assert.deepEqual(reported, usage);
	reported = undefined;
	await requestRemoteCompaction({}, [], authPair, {
		fetch: async () =>
			new Response(completedFrame([opaque], { usage: "not-an-object" }), {
				status: 200,
			}),
		onUsage: (value) => {
			reported = value;
		},
	});
	assert.equal(reported, undefined);
});

test("SSE frames and streams over their byte limits are rejected", async (t) => {
	const run = (response: Response) =>
		requestRemoteCompaction({}, [], authPair, { fetch: async () => response });
	await t.test("single frame", () =>
		assert.rejects(
			run(new Response(`data: ${"x".repeat(MAX_FRAME_BYTES + 1)}\n\n`)),
			/frame exceeded/,
		),
	);
	await t.test("unterminated frame", () =>
		assert.rejects(
			run(new Response(`data: ${"x".repeat(MAX_FRAME_BYTES + 1)}`)),
			/frame exceeded/,
		),
	);
	await t.test("whole stream", () => {
		const frame = `data: ${JSON.stringify({ type: "keepalive", pad: "x".repeat(1024 * 1024) })}\n\n`;
		return assert.rejects(
			run(
				new Response(
					frame.repeat(Math.ceil(MAX_STREAM_BYTES / frame.length) + 1),
				),
			),
			/stream exceeded/,
		);
	});
});

// Parsing speed is covered by the scaling test of the shared SSE reader; this
// checks that a checkpoint split into many chunks is reassembled intact.
test("a large frame split into many small chunks is reassembled intact", async () => {
	const payload = { ...opaque, encrypted_content: "e".repeat(1_500_000) };
	const text = completedFrame([payload]);
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) return controller.close();
			controller.enqueue(bytes.subarray(offset, offset + 64));
			offset += 64;
		},
	});
	const item = await requestRemoteCompaction({}, [], authPair, {
		fetch: async () => new Response(stream),
	});
	assert.equal(item.encrypted_content, payload.encrypted_content);
});

test("CRLF separators split across chunks are recognised", async () => {
	const text = completedFrame([opaque]).replace("\n\n", "\r\n\r\n");
	const separatorAt = text.indexOf("\r\n\r\n");
	const item = await requestRemoteCompaction({}, [], authPair, {
		fetch: async () =>
			chunkedResponse(text, [separatorAt + 1, 1, 1, text.length]),
	});
	assert.deepEqual(item, opaque);
});

test("checkpoints round-trip and oversized, unserializable, or corrupt ones are rejected", () => {
	const built = buildCheckpoint("gpt-5.4", "hash", opaque);
	assert.deepEqual(parseCheckpoint(built), built);
	assert.equal("usage" in built, false);
	const withUsage = buildCheckpoint("gpt-5.4", "hash", opaque, {
		input_tokens: 1,
	});
	assert.deepEqual(parseCheckpoint(withUsage), withUsage);
	assert.equal(parseCheckpoint({ ...built, usage: "corrupt" }), undefined);
	assert.equal(
		parseCheckpoint({
			...built,
			item: { ...opaque, encrypted_content: "x".repeat(MAX_FRAME_BYTES) },
		}),
		undefined,
	);
	assert.equal(
		parseCheckpoint({ ...built, item: { ...opaque, n: 1n } }),
		undefined,
	);
	assert.equal(parseCheckpoint({ ...built, extra: 1n }), undefined);
	assert.equal(parseCheckpoint(undefined), undefined);
	assert.equal(
		parseCheckpoint({ ...built, model: "m".repeat(257) }),
		undefined,
	);
});
