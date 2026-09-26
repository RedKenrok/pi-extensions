import assert from "node:assert/strict";
import test from "node:test";
import { createDebugSink, debugEnabled } from "../src/debug.ts";

test("PI_EXT_DEBUG enables this package by name or wildcard", () => {
	assert.equal(debugEnabled(undefined), false);
	assert.equal(debugEnabled(""), false);
	assert.equal(debugEnabled("fetch-tool"), false);
	assert.equal(debugEnabled("codex-compaction"), true);
	assert.equal(debugEnabled("fetch-tool, codex-compaction"), true);
	assert.equal(debugEnabled("*"), true);
});

test("the sink writes one reason line and never throws", () => {
	const lines: string[] = [];
	createDebugSink({ PI_EXT_DEBUG: "codex-compaction" }, (line) =>
		lines.push(line),
	)("remote_failed");
	assert.deepEqual(lines, ["[codex-compaction] remote_failed\n"]);

	createDebugSink({}, (line) => lines.push(line))("remote_failed");
	assert.equal(lines.length, 1);

	const failing = createDebugSink({ PI_EXT_DEBUG: "*" }, () => {
		throw new Error("EPIPE");
	});
	assert.doesNotThrow(() => failing("aborted"));
});
