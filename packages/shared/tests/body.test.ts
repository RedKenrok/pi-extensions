import assert from "node:assert/strict";
import test from "node:test";
import { chunkedResponse } from "../../../test-support/streams.ts";
import { BodyTooLargeError, readBodyWithLimit } from "../src/body.ts";

test("returns an empty array for a missing body", async () => {
	assert.equal((await readBodyWithLimit(null, 10)).byteLength, 0);
});

test("joins chunks and returns a single chunk without copying", async () => {
	const joined = await readBodyWithLimit(
		chunkedResponse("abcdef", [2, 2, 2]).body,
		6,
	);
	assert.equal(Buffer.from(joined).toString(), "abcdef");
	const single = await readBodyWithLimit(chunkedResponse("abc").body, 3);
	assert.equal(Buffer.from(single).toString(), "abc");
});

test("fails with the observed size once the limit is exceeded", async () => {
	await assert.rejects(
		readBodyWithLimit(chunkedResponse("abcdef", [4, 2]).body, 5),
		(error: unknown) =>
			error instanceof BodyTooLargeError &&
			error.maxBytes === 5 &&
			error.actualBytes === 6,
	);
});

test("an abort rejects with the signal's reason and releases the stream", async () => {
	const reason = new Error("stop");
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
	const read = readBodyWithLimit(body, 10, controller.signal);
	controller.abort(reason);
	await assert.rejects(read, (error: unknown) => error === reason);
	assert.equal(cancelled, true);
	assert.equal(body.locked, false);
});

test("a pre-aborted signal never reads", async () => {
	const controller = new AbortController();
	controller.abort(new Error("early"));
	await assert.rejects(
		readBodyWithLimit(chunkedResponse("abc").body, 10, controller.signal),
		/early/,
	);
});
