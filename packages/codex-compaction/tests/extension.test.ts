import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodexCompactionExtension } from "../index.ts";

test("registers only independent lifecycle hooks and no tool or command", () => {
	const events: string[] = [];
	let tools = 0;
	let commands = 0;
	const pi = {
		on(name: string) {
			events.push(name);
		},
		registerTool() {
			tools += 1;
		},
		registerCommand() {
			commands += 1;
		},
	} as unknown as ExtensionAPI;
	createCodexCompactionExtension()(pi);
	assert.deepEqual(events, [
		"session_before_compact",
		"before_provider_request",
	]);
	assert.equal(tools, 0);
	assert.equal(commands, 0);
});
