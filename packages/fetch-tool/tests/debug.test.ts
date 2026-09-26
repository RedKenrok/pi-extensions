import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { debug } from "../src/debug.ts";

const sink = (value: string | undefined) => {
	const lines: string[] = [];
	return {
		lines,
		sink: {
			env: value === undefined ? {} : { PI_EXT_DEBUG: value },
			write: (line: string) => {
				lines.push(line);
			},
		},
	};
};

describe("debug", () => {
	it("is silent unless this package or every package is enabled", () => {
		for (const value of [undefined, "", "notify", "fetch-toolish"]) {
			const { lines, sink: target } = sink(value);
			debug("reason", "detail", target);
			assert.deepEqual(lines, [], String(value));
		}
		for (const value of ["fetch-tool", "notify, fetch-tool", "*"]) {
			const { lines, sink: target } = sink(value);
			debug("reason", "detail", target);
			assert.deepEqual(lines, ["[fetch-tool] reason: detail\n"], value);
		}
	});

	it("keeps details to one bounded line and never throws", () => {
		const { lines, sink: target } = sink("*");
		debug("reason", `a\nb\x1b[31m${"x".repeat(300)}`, target);
		assert.equal(lines.length, 1);
		assert.match(lines[0] ?? "", /^\[fetch-tool\] reason: a b \[31mx+\n$/);
		assert.ok((lines[0]?.length ?? 0) < 240);
		assert.doesNotThrow(() =>
			debug("reason", "detail", {
				env: { PI_EXT_DEBUG: "*" },
				write: () => {
					throw new Error("EPIPE");
				},
			}),
		);
	});
});
