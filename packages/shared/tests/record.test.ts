import assert from "node:assert/strict";
import test from "node:test";
import { isRecord, nonemptyString, stringValue } from "../src/record.ts";

test("isRecord accepts only plain non-null objects", () => {
	assert.equal(isRecord({}), true);
	assert.equal(isRecord({ a: 1 }), true);
	for (const value of [null, undefined, [], "x", 1, true])
		assert.equal(isRecord(value), false);
});

test("string helpers reject non-strings and blank strings", () => {
	assert.equal(stringValue("x"), "x");
	assert.equal(stringValue(1), undefined);
	assert.equal(nonemptyString("  id  "), "id");
	assert.equal(nonemptyString("   "), undefined);
	assert.equal(nonemptyString(null), undefined);
});
