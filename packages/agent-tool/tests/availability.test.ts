import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_AUTOMATIC_PROBES,
	nextProbeAt,
	normalizeAvailability,
	sanitize,
} from "../src/availability.ts";
import type { Clock } from "../src/types.ts";

const clock: Clock = {
	now: () => new Date("2026-09-18T10:00:00.000Z"),
	setTimeout: () => 0,
	clearTimeout: () => {},
};

test("availability failures remain distinct and reset evidence is preserved", () => {
	assert.equal(
		normalizeAvailability({ status: 429 }, "s", clock.now()).kind,
		"short_rate_limit",
	);
	assert.deepEqual(
		normalizeAvailability({ status: 429, retryAfter: 120 }, "s", clock.now()),
		{
			kind: "short_rate_limit",
			scopeKey: "s",
			retryAt: "2026-09-18T10:02:00.000Z",
			provenance: "retry_after",
			automaticRetryAllowed: true,
		},
	);
	assert.equal(
		normalizeAvailability({ message: "weekly limit reached" }, "s", clock.now())
			.automaticRetryAllowed,
		false,
	);
	assert.equal(
		normalizeAvailability({ status: 401 }, "s", clock.now()).kind,
		"auth_required",
	);
	assert.equal(
		normalizeAvailability({ status: 403 }, "s", clock.now()).kind,
		"access_denied",
	);
	assert.equal(
		normalizeAvailability({ status: 500 }, "s", clock.now()).kind,
		"transient",
	);
	assert.equal(
		normalizeAvailability(
			{ status: 429, message: "ambiguous" },
			"s",
			clock.now(),
		).provenance,
		"unknown",
	);
});

test("unknown reset uses bounded exponential backoff, never an assumed five hours", () => {
	assert.equal(nextProbeAt(clock, 0), "2026-09-18T10:01:00.000Z");
	assert.equal(nextProbeAt(clock, 5), "2026-09-18T10:30:00.000Z");
	assert.equal(nextProbeAt(clock, 20), "2026-09-18T10:30:00.000Z");
	assert.equal(MAX_AUTOMATIC_PROBES, 6);
});

test("provider errors are sanitized before persistence", () => {
	assert.equal(
		sanitize("Authorization: Bearer-secret-value sk-abcdefghijk"),
		"[redacted] [redacted]",
	);
	assert.equal(
		sanitize("Authorization: Bearer secret-access-token"),
		"[redacted]",
	);
	assert.equal(
		sanitize("request failed for Bearer another-secret-token"),
		"request failed for [redacted]",
	);
});
