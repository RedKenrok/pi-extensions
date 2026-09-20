import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTimeoutSignal } from "../src/request.ts";

describe("createTimeoutSignal", () => {
	it("distinguishes timeout aborts from caller aborts", async () => {
		const timed = createTimeoutSignal(undefined, 10);
		await new Promise<void>((resolve) => {
			timed.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		assert.equal(timed.getAbortCause(), "timeout");
		timed.cleanup();

		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const cancelled = createTimeoutSignal(controller.signal, 10_000);
		assert.equal(cancelled.signal?.aborted, true);
		assert.equal(cancelled.getAbortCause(), "caller");
		cancelled.cleanup();
	});
});
