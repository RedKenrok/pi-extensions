import assert from "node:assert/strict";
import test from "node:test";
import { jwt } from "../../../test-support/jwt.ts";
import { summaryItem } from "../index.ts";
import { captureCodexInput } from "../src/remote.ts";
import { model } from "./fakes.ts";

// These tests run against the installed Pi packages rather than fixtures. CI
// runs them for every supported Pi version, so wording or conversion changes
// upstream fail here instead of silently disabling replay.

test("Pi's converted compaction summary matches the replay summary shape", async () => {
	const captured = await captureCodexInput(
		model,
		[
			{
				role: "compactionSummary",
				summary: "readable summary",
				tokensBefore: 10,
				timestamp: 1,
			},
		],
		jwt("acct"),
	);
	assert.equal(captured.input.length, 1);
	assert.equal(summaryItem(captured.input[0], "readable summary"), true);
	assert.equal(summaryItem(captured.input[0], "different summary"), false);
});

test("payload capture never reaches the network", async () => {
	const original = globalThis.fetch;
	let called = false;
	globalThis.fetch = async () => {
		called = true;
		return new Response();
	};
	try {
		const captured = await captureCodexInput(
			model,
			[{ role: "user", content: "hello", timestamp: 1 }],
			jwt("acct"),
		);
		assert.equal(captured.template.stream, true);
		assert.equal("input" in captured.template, false);
	} finally {
		globalThis.fetch = original;
	}
	assert.equal(called, false);
});
