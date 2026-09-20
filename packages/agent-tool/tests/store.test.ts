import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STATE_VERSION, StateVersionError, Store } from "../src/store.ts";
import { agent } from "./helpers.ts";

function statePath(prefix: string): string {
	return join(mkdtempSync(join(tmpdir(), prefix)), "state");
}

test("loose JSON state reopens agents, messages, events, and outbox", () => {
	const path = statePath("pi-tools-store-");
	let store = new Store(path);
	const record = agent();
	store.transaction(() => {
		store.insertAgent(record, "literal task");
		store.addEvent(
			record.agentId,
			record.currentRunId,
			"accepted",
			{},
			record.createdAt,
		);
	});
	const literalText = "/literal $" + "{HOME}";
	store.addMessage({
		messageId: "msg_1",
		agentId: record.agentId,
		runId: record.currentRunId,
		delivery: "followUp",
		text: literalText,
		state: "queued",
		sequence: 1,
		createdAt: record.createdAt,
	});
	store.close();
	store = new Store(path);
	assert.equal(store.getAgent(record.agentId)?.task, "test");
	assert.equal(store.pendingMessages(record.agentId)[0]?.text, literalText);
	const event = store.events([record.agentId], 0)[0];
	assert(event);
	store.enqueueOutbox(
		event.id,
		record.parentSessionId,
		record.agentId,
		{ ok: true },
		record.createdAt,
	);
	store.close();
	store = new Store(path);
	assert.equal(store.pendingOutbox(record.parentSessionId).length, 1);
	store.ackOutbox(record.parentSessionId, [event.id], record.createdAt);
	assert.equal(store.pendingOutbox(record.parentSessionId).length, 0);
});

test("state uses separate versioned JSON documents", () => {
	const path = statePath("pi-tools-layout-");
	const store = new Store(path);
	const record = agent();
	store.insertAgent(record, "task");
	const manifest = JSON.parse(
		readFileSync(join(path, "manifest.json"), "utf8"),
	);
	const storedAgent = JSON.parse(
		readFileSync(join(path, "agents", `${record.agentId}.json`), "utf8"),
	);
	assert.equal(manifest.version, STATE_VERSION);
	assert.equal(storedAgent.version, STATE_VERSION);
	assert.equal(storedAgent.kind, "agent");
	assert(existsSync(join(path, "global.json")));
});

test("a schema mismatch clears disposable state and requests restart", () => {
	const path = statePath("pi-tools-version-");
	new Store(path).close();
	const manifestPath = join(path, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.version = 0;
	writeFileSync(manifestPath, JSON.stringify(manifest));
	assert.throws(
		() => new Store(path),
		(error: unknown) =>
			error instanceof StateVersionError &&
			error.restartRequired &&
			/restart Pi/i.test(error.message),
	);
	assert.equal(existsSync(path), false);
	const fresh = new Store(path);
	assert.equal(fresh.countAgents(), 0);
});

test("acknowledgement cannot revive a superseded notification", () => {
	const store = new Store(statePath("pi-tools-outbox-race-"));
	const record = agent();
	store.insertAgent(record, "task");
	const eventId = store.addEvent(
		record.agentId,
		record.currentRunId,
		"completed",
		{},
		record.createdAt,
	);
	store.enqueueOutbox(
		eventId,
		record.parentSessionId,
		record.agentId,
		{ kind: "agent_resolved" },
		record.createdAt,
	);
	store.supersedeAgentOutbox(
		record.parentSessionId,
		[record.agentId],
		record.updatedAt,
	);
	store.ackOutbox(record.parentSessionId, [eventId], record.updatedAt);
	assert.equal(store.outboxState(eventId), "superseded");
});

test("unfinished write operations remain visible for best-effort recovery", () => {
	const store = new Store(statePath("pi-tools-uncertain-"));
	const record = agent();
	store.insertAgent(record, "task");
	store.toolStart(
		record.agentId,
		record.currentRunId,
		1,
		"call-read",
		"read",
		"a",
		record.createdAt,
	);
	store.toolStart(
		record.agentId,
		record.currentRunId,
		1,
		"call-write",
		"write",
		"b",
		record.createdAt,
	);
	store.toolFinish(
		record.agentId,
		record.currentRunId,
		"call-read",
		record.createdAt,
	);
	assert.deepEqual(store.uncertainTools(record.agentId, record.currentRunId), [
		{ toolCallId: "call-write", toolName: "write" },
	]);
});

test("idle barriers retain ordered membership", () => {
	const path = statePath("pi-tools-idle-");
	let store = new Store(path);
	const first = agent({ agentId: "ag_1", currentRunId: "run_1" });
	const second = agent({ agentId: "ag_2", currentRunId: "run_2" });
	store.insertAgent(first, "one");
	store.insertAgent(second, "two");
	store.insertIdle(
		{
			idleId: "idle_1",
			parentSessionId: "parent-a",
			state: "pending",
			until: "all_settled",
			activityPolicy: "keep",
			wakeMode: "auto",
			disconnectPolicy: "defer",
			headlessState: "none",
			createdAt: first.createdAt,
		},
		["ag_2", "ag_1"],
	);
	store.close();
	store = new Store(path);
	assert.deepEqual(
		store.idleAgents("idle_1").map((value) => value.agentId),
		["ag_2", "ag_1"],
	);
});

test("usage reports preserve current-run deltas and aggregate lifetime", () => {
	const store = new Store(statePath("pi-tools-usage-"));
	const record = agent();
	store.insertAgent(record, "first");
	store.updateRunUsage(record.currentRunId, {
		input: 100,
		output: 20,
		cacheRead: 40,
		cacheWrite: 5,
		totalTokens: 120,
		cost: null,
	});
	store.createRun("run_second", record.agentId, 2, "second", record.createdAt);
	store.updateRunUsage("run_second", {
		input: 50,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 60,
		cost: 0.25,
	});
	const report = store.usageReport(record.agentId, "run_second", {
		runtimeSeconds: 3600,
	});
	assert.equal(report.currentRun?.totalTokens, 60);
	assert.deepEqual(report.lifetime, {
		input: 150,
		output: 30,
		cacheRead: 40,
		cacheWrite: 5,
		totalTokens: 180,
		cost: 0.25,
		runs: 2,
	});
});
