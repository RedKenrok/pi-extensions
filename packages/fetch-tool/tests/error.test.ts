import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeError, redactUrl } from "../src/error.ts";

describe("redactUrl", () => {
	it("removes userinfo and leaves other URLs unchanged", () => {
		assert.equal(
			redactUrl("https://u:p@example.com/a?b=1"),
			"https://example.com/a?b=1",
		);
		assert.equal(redactUrl("https://u@example.com/"), "https://example.com/");
		assert.equal(redactUrl("https://example.com/x"), "https://example.com/x");
	});

	it("strips userinfo textually from unparseable input", () => {
		assert.equal(redactUrl("http://u:p@exa mple/"), "http://exa mple/");
		assert.equal(redactUrl("not a url"), "not a url");
	});
});

describe("normalizeError", () => {
	it("keeps typed tool errors", () => {
		const error = Object.assign(new Error("too big"), {
			errorType: "size_limit",
			maxSize: 1,
			actualSize: 2,
		});
		assert.deepEqual(normalizeError(error, "https://u:p@x.test/", 50), {
			errorType: "size_limit",
			message: "too big",
			url: "https://x.test/",
			timeout: 50,
			maxSize: 1,
			actualSize: 2,
		});
	});

	it("uses the deadline's abort cause over the thrown reason", () => {
		const reason = new DOMException("x", "AbortError");
		assert.equal(
			normalizeError(reason, "https://x.test", 100, "timeout").errorType,
			"timeout",
		);
		assert.equal(
			normalizeError(reason, "https://x.test", 100, "timeout").message,
			"Request timed out after 100ms",
		);
		assert.equal(
			normalizeError(reason, "https://x.test", 100, "caller").errorType,
			"aborted",
		);
	});

	it("classifies ordinary errors and non-errors", () => {
		assert.deepEqual(normalizeError(new Error("boom"), "https://x.test"), {
			errorType: "fetch",
			message: "boom",
			url: "https://x.test",
			timeout: undefined,
		});
		assert.equal(
			normalizeError("weird", "https://x.test").errorType,
			"unknown",
		);
	});
});
