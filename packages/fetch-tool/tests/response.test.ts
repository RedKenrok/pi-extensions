import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readResponseWithLimit } from "../src/response.ts";

const responseFrom = (
	stream: ReadableStream<Uint8Array>,
	headers?: HeadersInit,
) => new Response(stream, headers ? { headers } : {});

describe("readResponseWithLimit", () => {
	it("rejects promptly when a stalled stream is aborted and releases its lock", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise<void>(() => {});
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = responseFrom(stream);
		const read = readResponseWithLimit(response, 10, controller.signal);
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort(new Error("cancel stalled read"));
		await assert.rejects(read, /cancel stalled read/);
		assert.equal(cancelled, true);
		assert.equal(response.body?.locked, false);
	});

	it("preserves the abort reason object", async () => {
		const reason = new DOMException("operation stopped", "AbortError");
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(reason);
			},
		});
		const response = responseFrom(stream);
		await assert.rejects(
			readResponseWithLimit(response, 10),
			(error) => error === reason,
		);
		assert.equal(response.body?.locked, false);
	});

	it("rejects streamed bytes beyond the limit despite a lying Content-Length", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.enqueue(new Uint8Array([4, 5, 6]));
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = responseFrom(stream, { "content-length": "1" });
		await assert.rejects(
			readResponseWithLimit(response, 4),
			(error: Error & { errorType?: string; actualSize?: number }) => {
				assert.equal(error.errorType, "size_limit");
				assert.equal(error.actualSize, 6);
				return true;
			},
		);
		assert.equal(response.body?.locked, false);
		assert.equal(cancelled, true);
	});

	it("releases the reader lock after a read rejection", async () => {
		const failure = new Error("read failed");
		const response = responseFrom(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(failure);
				},
			}),
		);
		await assert.rejects(
			readResponseWithLimit(response, 10),
			(error) => error === failure,
		);
		assert.equal(response.body?.locked, false);
	});

	it("preserves bytes for near-limit multi-chunk and concurrent reads", async () => {
		const makeResponse = (parts: number[][]) =>
			responseFrom(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (const part of parts) controller.enqueue(Uint8Array.from(part));
						controller.close();
					},
				}),
			);
		const first = makeResponse([
			[0, 1],
			[2, 3, 4],
			[5, 6],
		]);
		const second = makeResponse([[255], [10, 11], [12, 13]]);
		const [a, b] = await Promise.all([
			readResponseWithLimit(first, 7),
			readResponseWithLimit(second, 6),
		]);
		assert.deepEqual([...a], [0, 1, 2, 3, 4, 5, 6]);
		assert.deepEqual([...b], [255, 10, 11, 12, 13]);
		assert.equal(first.body?.locked, false);
		assert.equal(second.body?.locked, false);
	});
});
