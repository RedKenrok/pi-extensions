import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileInterrupted } from "../src/recovery.ts";
import { Store } from "../src/store.ts";
import { agent } from "./helpers.ts";

test("read-only uncertainty is repeatable but writes require reconciliation", () => {
	const store = new Store(
		join(mkdtempSync(join(tmpdir(), "pi-tools-recovery-")), "state"),
	);
	const record = agent();
	store.insertAgent(record, "task");
	store.toolStart(
		record.agentId,
		record.currentRunId,
		1,
		"read-1",
		"read",
		"hash",
		record.createdAt,
	);
	assert.equal(reconcileInterrupted(store, record).safe, true);
	store.toolStart(
		record.agentId,
		record.currentRunId,
		1,
		"write-1",
		"write",
		"hash",
		record.createdAt,
	);
	const result = reconcileInterrupted(store, record);
	assert.equal(result.safe, false);
	assert.equal(result.reason, "uncertain_side_effects");
	store.close();
});
