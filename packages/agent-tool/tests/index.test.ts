import assert from "node:assert/strict";
import test from "node:test";
import {
	catalogContent,
	idleResult,
	notificationContent,
	spawnContent,
} from "../index.ts";

test("idle notification explains that truncated child output is not retrievable", () => {
	const content = notificationContent({
		eventId: 7,
		agentId: "ag_1",
		payload: {
			kind: "idle_resolved",
			idleId: "idle_1",
			resolution: "all_settled",
			agents: [
				{
					agentId: "ag_1",
					runId: "run_1",
					state: "completed",
					summary: "review complete",
				},
				{
					agentId: "ag_2",
					runId: "run_2",
					state: "failed",
					summary: "provider failure",
					outputTruncated: true,
				},
			],
		},
	});
	assert.match(content, /Agent group idle_1 has resolved/);
	assert.match(content, /ag_1 completed: review complete/);
	assert.match(content, /final result excerpts above are bounded/i);
	assert.match(content, /intentionally unavailable/);
	assert.match(content, /concise restatement/);
	assert.doesNotMatch(content, /includeOutput|remaining output/);
});

test("complete idle notification omits unnecessary inspect guidance", () => {
	const content = notificationContent({
		eventId: 8,
		agentId: "ag_1",
		payload: {
			kind: "idle_resolved",
			idleId: "idle_1",
			resolution: "all_settled",
			agents: [
				{
					agentId: "ag_1",
					state: "completed",
					summary: "complete result",
				},
			],
		},
	});
	assert.doesNotMatch(content, /action inspect|includeOutput/);
});

test("individual terminal notification uses resolved wording", () => {
	const content = notificationContent({
		eventId: 8,
		agentId: "ag_3",
		payload: {
			kind: "agent_resolved",
			status: "completed",
			summary: "done",
			usage: {
				currentRun: {
					input: 100,
					output: 20,
					cacheRead: 50,
					cacheWrite: 0,
					totalTokens: 120,
					cost: null,
				},
				lifetime: {
					input: 100,
					output: 20,
					cacheRead: 50,
					cacheWrite: 0,
					totalTokens: 120,
					cost: null,
					runs: 1,
				},
				limits: { runtimeSeconds: 3600 },
				subscriptionQuota: "unknown",
			},
		},
	});
	assert.match(content, /Agent ag_3 has resolved as completed/);
	assert.doesNotMatch(content, /action inspect/);
	assert.match(content, /Run usage: 120 tokens/);
	assert.match(content, /cost unknown/);
});

test("truncated individual completion does not offer full output retrieval", () => {
	const content = notificationContent({
		eventId: 9,
		agentId: "ag_4",
		payload: {
			kind: "agent_resolved",
			status: "completed",
			summary: "result excerpt",
			outputTruncated: true,
		},
	});
	assert.match(content, /final result excerpt above was truncated/i);
	assert.match(content, /intentionally unavailable/);
	assert.match(content, /resume agent ag_4/);
	assert.doesNotMatch(content, /includeOutput|remaining output/);
});

test("spawn output makes a known provider block and recovery action explicit", () => {
	const content = spawnContent({
		agentId: "ag_1",
		runId: "run_1",
		state: "blocked",
		reason: "quota_manual_resume_required",
		effective: {
			model: { provider: "openai-codex", id: "gpt-5.6-luna" },
			reasoning: "high",
			cwd: "/tmp/project",
		},
		admission: {
			status: "manual_retry_required",
			message:
				"Provider scope is blocked after six probes. Do not spawn duplicates.",
		},
	});
	assert.match(content, /as blocked/);
	assert.match(content, /gpt-5\.6-luna/);
	assert.equal((content.match(/Do not spawn duplicates/g) ?? []).length, 1);
});

test("spawn output explains automatic completion without requiring idle", () => {
	const content = spawnContent({
		agentId: "ag_1",
		runId: "run_1",
		state: "running",
		effective: {
			model: { provider: "openai-codex", id: "gpt-5.6-luna" },
			reasoning: "high",
			cwd: "/tmp/project",
			limits: { runtimeSeconds: 3600 },
		},
	});
	assert.match(content, /without polling/);
	assert.match(content, /resume this parent/);
	assert.match(content, /idle only to join/);
	assert.doesNotMatch(content, /call agent with action idle/);
	assert.match(content, /stop only to cancel/);
	assert.match(content, /Runtime limit: 3600 seconds/);
});

test("an armed idle join terminates while immediate resolution continues", () => {
	const agent = {
		agentId: "ag_1",
		state: "running",
		summary: "still running",
	};
	const armed = idleResult({
		idleId: "idle_1",
		state: "armed",
		agents: [agent],
	});
	assert.equal(armed.terminate, true);
	assert.match(armed.content[0]?.text ?? "", /run will settle now/);

	const resolved = idleResult({
		idleId: "idle_2",
		state: "resolved",
		resolution: "all_settled",
		agents: [{ ...agent, state: "completed", summary: "done" }],
	});
	assert.equal("terminate" in resolved, false);
	assert.match(resolved.content[0]?.text ?? "", /resolved immediately/);
});

test("catalog output reports known scheduler admission blocks", () => {
	const content = catalogContent({
		profiles: [],
		selection: "scoped",
		models: [
			{
				provider: "one",
				id: "small",
				reasoning: ["low", "medium", "high"],
				configuredReasoning: "medium",
				scopeId: "scope-a",
			},
			{
				provider: "one",
				id: "large",
				reasoning: ["low", "high", "max"],
				scopeId: "scope-a",
			},
			{
				provider: "two",
				id: "fast",
				reasoning: ["off"],
				scopeId: "scope-b",
			},
		],
		scopes: [
			{
				scopeId: "scope-a",
				provider: "one",
				admission: { status: "manual_retry_required", message: "manual" },
			},
			{
				scopeId: "scope-b",
				provider: "two",
				admission: { status: "cooling_down", message: "cooling" },
			},
		],
	});
	assert.match(content, /3 model\(s\) from the session-scoped model selection/);
	assert.match(content, /one\/small; supported efforts: low, medium, high/);
	assert.match(content, /selected effort: medium/);
	assert.match(content, /1 manual-retry, 1 cooling-down provider scope/);
	assert.doesNotMatch(content, /quota|unknown/);
});

test("catalog output omits quota and admission boilerplate without known blocks", () => {
	const content = catalogContent({
		profiles: [],
		selection: "all",
		models: [
			{
				provider: "one",
				id: "small",
				reasoning: ["low"],
				scopeId: "scope-a",
			},
		],
		scopes: [
			{
				scopeId: "scope-a",
				provider: "one",
				admission: { status: "no_known_block", message: "none" },
			},
		],
	});
	assert.doesNotMatch(content, /quota|unknown|scheduler block/i);
});
