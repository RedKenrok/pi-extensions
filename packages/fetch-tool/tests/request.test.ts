import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { holdingEventLoop } from "../../../test-support/async.ts";
import { createDeadline } from "../src/request.ts";

describe("createDeadline", () => {
	it("attributes a caller abort to the caller", () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const deadline = createDeadline(controller.signal, 10_000);
		assert.equal(deadline.signal.aborted, true);
		assert.throws(() => deadline.check(), /cancelled/);
		assert.equal(deadline.cause(), "caller");
	});

	it("expires by elapsed time even when the timer has not fired yet", () => {
		let now = 1_000;
		const deadline = createDeadline(undefined, 500, () => now);
		deadline.check();
		assert.equal(deadline.cause(), undefined);
		now = 1_500;
		assert.throws(
			() => deadline.check(),
			(error: Error) => error.name === "TimeoutError",
		);
		assert.equal(deadline.cause(), "timeout");
	});

	it("aborts its signal when the timeout elapses", () => {
		const controller = new AbortController();
		const timer = new AbortController();
		let requested: number | undefined;
		const deadline = createDeadline(controller.signal, 100, Date.now, (ms) => {
			requested = ms;
			return timer.signal;
		});
		assert.equal(requested, 100);
		assert.equal(deadline.signal.aborted, false);
		timer.abort(new DOMException("elapsed", "TimeoutError"));
		assert.equal(deadline.signal.aborted, true);
		assert.equal(deadline.cause(), "timeout");
		// A late caller abort must not relabel an earlier timeout.
		controller.abort(new Error("late"));
		assert.equal(deadline.cause(), "timeout");
	});
});

describe("createDeadline default timer", () => {
	it("uses a real AbortSignal.timeout", async () => {
		const deadline = createDeadline(undefined, 100);
		await holdingEventLoop(
			() =>
				new Promise<void>((resolve) => {
					deadline.signal.addEventListener("abort", () => resolve(), {
						once: true,
					});
				}),
		);
		assert.equal(deadline.cause(), "timeout");
	});
});
