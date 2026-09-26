import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnostics, diagnosticsEnabled } from "../src/diagnostics.ts";

test("PI_EXT_DEBUG selects packages by name or wildcard", () => {
	assert.equal(diagnosticsEnabled("pkg", {}), false);
	assert.equal(diagnosticsEnabled("pkg", { PI_EXT_DEBUG: "" }), false);
	assert.equal(diagnosticsEnabled("pkg", { PI_EXT_DEBUG: "other" }), false);
	assert.equal(diagnosticsEnabled("pkg", { PI_EXT_DEBUG: "other, pkg" }), true);
	assert.equal(diagnosticsEnabled("pkg", { PI_EXT_DEBUG: "*" }), true);
});

test("writes one sanitized line per call only when enabled", () => {
	const silent: string[] = [];
	createDiagnostics("pkg", {
		env: {},
		write: (line) => {
			silent.push(line);
		},
	})("ignored");
	assert.equal(silent.length, 0);

	const lines: string[] = [];
	const diagnose = createDiagnostics("pkg", {
		env: { PI_EXT_DEBUG: "pkg" },
		write: (line) => {
			lines.push(line);
		},
	});
	diagnose("plain");
	diagnose("detailed", `a\n\x1b[31mb${"x".repeat(300)}`);
	const [plain, detailed = ""] = lines;
	assert.equal(plain, "[pkg] plain\n");
	assert.ok(detailed.startsWith("[pkg] detailed: a [31mb"));
	assert.equal(detailed.split("\n").length, 2);
	assert.ok(detailed.length < 230);
});

test("a failing writer never throws into the caller", () => {
	const diagnose = createDiagnostics("pkg", {
		env: { PI_EXT_DEBUG: "*" },
		write: () => {
			throw new Error("EPIPE");
		},
	});
	assert.doesNotThrow(() => diagnose("reason"));
});

test("defaults to process.env and stderr", (t) => {
	const writes: string[] = [];
	t.mock.method(process.stderr, "write", (chunk: string) => {
		writes.push(chunk);
		return true;
	});
	const previous = process.env.PI_EXT_DEBUG;
	process.env.PI_EXT_DEBUG = "pkg";
	try {
		createDiagnostics("pkg")("reason");
	} finally {
		if (previous === undefined) delete process.env.PI_EXT_DEBUG;
		else process.env.PI_EXT_DEBUG = previous;
	}
	assert.deepEqual(writes, ["[pkg] reason\n"]);
});
