import assert from "node:assert/strict";
import { describe, it } from "node:test";
import extension from "../index.ts";

describe("fetch extension registration", () => {
	it("registers the fetch tool", () => {
		let registered: { name?: string } | undefined;
		extension({
			registerTool(tool: { name?: string }) {
				registered = tool;
			},
		} as never);
		assert.equal(registered?.name, "fetch");
	});
});
