import assert from "node:assert/strict";
import test from "node:test";
import { diagnose, formatDuration, PACKAGE_NAME } from "../src/util.ts";

test("formats deadlines in the largest whole unit", () => {
	assert.equal(formatDuration(10 * 60_000), "10 minutes");
	assert.equal(formatDuration(60_000), "1 minute");
	assert.equal(formatDuration(5_000), "5 seconds");
	assert.equal(formatDuration(1_000), "1 second");
	assert.equal(formatDuration(1_500), "1500 ms");
	assert.equal(formatDuration(5), "5 ms");
});

test("diagnostics are written only for enabled package names", () => {
	assert.equal(PACKAGE_NAME, "codex-research-tool");
	const lines: string[] = [];
	const write = (line: string) => lines.push(line);
	diagnose("reason", {}, write);
	diagnose("reason", { PI_EXT_DEBUG: "fetch-tool" }, write);
	diagnose("first", { PI_EXT_DEBUG: "fetch-tool, codex-research-tool" }, write);
	diagnose("second", { PI_EXT_DEBUG: "*" }, write);
	assert.deepEqual(lines, [
		"[codex-research-tool] first\n",
		"[codex-research-tool] second\n",
	]);
});
