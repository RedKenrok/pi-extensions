import assert from "node:assert/strict";
import test from "node:test";
import { chunkedResponse } from "../../../test-support/streams.ts";
import { parseSseFrame, SseLimitError, sseFrames } from "../src/sse.ts";

const limits = { maxStreamBytes: 1024 * 1024, maxFrameBytes: 64 * 1024 };

async function collect(
	text: string,
	chunks?: number[],
	options: Partial<typeof limits> & { signal?: AbortSignal } = {},
): Promise<string[]> {
	const frames: string[] = [];
	const body = chunkedResponse(text, chunks).body;
	assert.ok(body);
	for await (const frame of sseFrames(body, { ...limits, ...options }))
		frames.push(frame);
	return frames;
}

test("splits frames on LF and CRLF blank lines, including a trailing frame", async () => {
	assert.deepEqual(await collect("a: 1\n\nb: 2\r\n\r\nc: 3"), [
		"a: 1",
		"b: 2",
		"c: 3",
	]);
	assert.deepEqual(await collect("a\n\n  \n"), ["a"]);
});

test("finds separators and multi-byte characters split across every chunk boundary", async () => {
	const text = "data: é€\r\n\r\ndata: 🦊\n\ndata: z\n\n";
	const expected = ["data: é€", "data: 🦊", "data: z"];
	for (let size = 1; size <= 4; size++) {
		const chunks = Array.from({ length: Buffer.byteLength(text) }, () => size);
		assert.deepEqual(
			await collect(text, chunks),
			expected,
			`chunk size ${size}`,
		);
	}
});

test("enforces stream and frame limits", async () => {
	await assert.rejects(
		collect("data: 12345\n\n", undefined, { maxStreamBytes: 5 }),
		(error: unknown) =>
			error instanceof SseLimitError && error.kind === "stream",
	);
	await assert.rejects(
		collect("data: 12345\n\n", undefined, { maxFrameBytes: 5 }),
		(error: unknown) =>
			error instanceof SseLimitError && error.kind === "frame",
	);
	// A frame that never ends must be rejected before the stream limit.
	await assert.rejects(
		collect("x".repeat(100), [10, 10, 10, 10, 10, 10, 10, 10, 10, 10], {
			maxFrameBytes: 50,
		}),
		(error: unknown) =>
			error instanceof SseLimitError && error.kind === "frame",
	);
});

async function timeOneFrame(bytes: number): Promise<number> {
	const frame = `data: ${"x".repeat(bytes)}`;
	const text = `${frame}\n\n`;
	const chunks = Array.from({ length: Math.ceil(text.length / 16) }, () => 16);
	const started = performance.now();
	const frames = await collect(text, chunks, {
		maxFrameBytes: 4 * 1024 * 1024,
	});
	const elapsed = performance.now() - started;
	assert.deepEqual(frames, [frame]);
	return elapsed;
}

// Compares growth rather than an absolute time budget, so a slow or
// instrumented run cannot fail it: four times the input takes about four
// times as long when parsing is linear, and about sixteen times when every
// chunk rescans the pending text.
test("parse time grows linearly with frame size in tiny chunks", async () => {
	await timeOneFrame(64 * 1024);
	const small = Math.min(
		await timeOneFrame(128 * 1024),
		await timeOneFrame(128 * 1024),
	);
	const large = Math.min(
		await timeOneFrame(512 * 1024),
		await timeOneFrame(512 * 1024),
	);
	assert.ok(
		large / small < 10,
		`4x input took ${(large / small).toFixed(1)}x as long`,
	);
});

test("an abort rejects with the signal's reason and cancels the stream", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull() {
			return new Promise(() => {});
		},
		cancel() {
			cancelled = true;
		},
	});
	const controller = new AbortController();
	const reason = new Error("stop");
	const iterator = sseFrames(body, { ...limits, signal: controller.signal });
	const next = iterator.next();
	controller.abort(reason);
	await assert.rejects(next, (error: unknown) => error === reason);
	assert.equal(cancelled, true);
});

test("an early return by the consumer cancels the stream", async () => {
	let cancelled = false;
	let sent = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!sent) {
				sent = true;
				controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
			}
			return new Promise(() => {});
		},
		cancel() {
			cancelled = true;
		},
	});
	for await (const frame of sseFrames(body, limits)) {
		assert.equal(frame, "data: 1");
		break;
	}
	assert.equal(cancelled, true);
	assert.equal(body.locked, false);
});

test("parseSseFrame joins data lines and ignores empty and DONE frames", () => {
	assert.deepEqual(parseSseFrame('event: e\ndata: {"a":\ndata:  1}\nid: 3'), {
		event: "e",
		data: '{"a":\n1}',
	});
	assert.deepEqual(parseSseFrame("data: x"), { event: "", data: "x" });
	assert.equal(parseSseFrame("event: e"), undefined);
	assert.equal(parseSseFrame("data:   "), undefined);
	assert.equal(parseSseFrame("data: [DONE]"), undefined);
	assert.equal(parseSseFrame(": comment"), undefined);
});
