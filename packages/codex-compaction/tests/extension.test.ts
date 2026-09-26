import assert from "node:assert/strict";
import test from "node:test";
import { createCodexCompactionExtension } from "../index.ts";
import { fakePi } from "./fakes.ts";

test("registers only independent lifecycle hooks and no tool or command", () => {
	let tools = 0;
	let commands = 0;
	const pi = fakePi({
		registerTool() {
			tools += 1;
		},
		registerCommand() {
			commands += 1;
		},
	});
	createCodexCompactionExtension()(pi.api);
	assert.deepEqual(pi.events, [
		"session_before_compact",
		"before_provider_request",
	]);
	assert.equal(tools, 0);
	assert.equal(commands, 0);
});
