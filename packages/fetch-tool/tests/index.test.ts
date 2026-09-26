import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

describe("fetch extension registration", () => {
	it("registers the fetch tool", () => {
		const registered: string[] = [];
		const pi: Pick<ExtensionAPI, "registerTool"> = {
			registerTool(tool) {
				registered.push(tool.name);
			},
		};
		extension(pi);
		assert.deepEqual(registered, ["fetch"]);
	});
});
