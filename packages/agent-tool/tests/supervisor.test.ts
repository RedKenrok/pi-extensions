// biome-ignore-all lint/style/noNonNullAssertion: Tests assert fixtures and persisted records created immediately before access.
// biome-ignore-all lint/suspicious/noExplicitAny: White-box tests intentionally inspect and replace private supervisor internals.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stableHash } from "../src/ids.ts";
import { Supervisor } from "../src/supervisor.ts";
import type { Clock } from "../src/types.ts";
import { agent, request } from "./helpers.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-supervisor-"));
	const clock: Clock = {
		now: () => new Date("2026-09-18T10:00:00.000Z"),
		setTimeout: () => 0,
		clearTimeout: () => {},
	};
	const supervisor = new Supervisor({
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		clock,
		jitter: () => 0,
		launchWorker: () => ({ pid: process.pid }),
	});
	return { supervisor, clock };
}

function fauxRuntime(
	_dir: string,
	providerNames = ["pi-tools-test"],
	modelIds = ["test"],
): ModelRuntime {
	const models = providerNames.flatMap(
		(provider) =>
			fauxProvider({
				provider,
				models: modelIds.map((id) => ({ id, reasoning: false })),
			}).models,
	);
	return {
		getModel: (provider: string, id: string) =>
			models.find((model) => model.provider === provider && model.id === id),
		getAvailable: (provider?: string) =>
			Promise.resolve(
				provider
					? models.filter((model) => model.provider === provider)
					: models,
			),
	} as unknown as ModelRuntime;
}

test("duplicate durable messages are idempotent and payload reuse conflicts", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(agent(), "task");
	const action = {
		action: "message",
		agentId: "ag_test",
		delivery: "followUp",
		text: "one",
		requestId: "same",
	} as const;
	const first = (await supervisor.handle(request(action))) as any;
	const second = (await supervisor.handle(request(action))) as any;
	assert.equal(first.messageId, second.messageId);
	assert.equal(supervisor.store.pendingMessages("ag_test").length, 1);
	await assert.rejects(
		() => supervisor.handle(request({ ...action, text: "different" })),
		/different arguments/,
	);
	supervisor.stop();
});

test("a saved spawn can replay the same identity after restart", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-spawn-replay-"));
	const runtime = await fauxRuntime(dir);
	const clock: Clock = {
		now: () => new Date("2026-09-18T10:00:00.000Z"),
		setTimeout: () => 0,
		clearTimeout: () => {},
	};
	const options = {
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		clock,
		maxRunning: 0,
		modelRuntime: runtime,
		launchWorker: () => ({ pid: process.pid }),
	};
	const action = {
		action: "spawn",
		prompt: "durable task",
		model: { provider: "pi-tools-test", id: "test" },
		reasoning: "off",
		tools: [] as string[],
		requestId: "lost-ack",
	} as const;
	let supervisor = new Supervisor(options);
	const committed = (await supervisor.handle(request(action))) as any;
	supervisor.stop();

	supervisor = new Supervisor(options);
	const replayed = (await supervisor.handle(request(action))) as any;
	assert.equal(replayed.agentId, committed.agentId);
	assert.equal(replayed.runId, committed.runId);
	assert.deepEqual(replayed.effective.limits, { runtimeSeconds: 3600 });
	assert.equal(supervisor.store.countAgents(), 1);
	supervisor.stop();
});

test("idempotent worktree replay verifies persisted provenance before returning cached metadata", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-worktree-replay-"));
	const runtime = await fauxRuntime(dir);
	const source = mkdtempSync(join(tmpdir(), "pi-tools-worktree-source-"));
	execFileSync("git", ["init", "-q", source]);
	execFileSync("git", ["-C", source, "config", "user.name", "Pi Tools Test"]);
	execFileSync("git", [
		"-C",
		source,
		"config",
		"user.email",
		"pi-tools@example.invalid",
	]);
	writeFileSync(join(source, "tracked.txt"), "first\n");
	execFileSync("git", ["-C", source, "add", "tracked.txt"]);
	execFileSync("git", ["-C", source, "commit", "-q", "-m", "initial"]);
	const supervisor = new Supervisor({
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		maxRunning: 0,
		modelRuntime: runtime,
	});
	const action = {
		action: "spawn",
		prompt: "durable task",
		model: { provider: "pi-tools-test", id: "test" },
		reasoning: "off",
		tools: [] as string[],
		cwd: source,
		workspace: "worktree",
		requestId: "worktree-replay",
	} as const;
	const committed = (await supervisor.handle(
		request(action, { cwd: source }),
	)) as any;
	writeFileSync(join(committed.effective.cwd, "changed.txt"), "changed\n");
	execFileSync("git", ["-C", committed.effective.cwd, "add", "changed.txt"]);
	execFileSync("git", [
		"-C",
		committed.effective.cwd,
		"-c",
		"user.name=Pi Tools Test",
		"-c",
		"user.email=pi-tools@example.invalid",
		"commit",
		"-q",
		"-m",
		"tamper",
	]);
	await assert.rejects(
		() => supervisor.handle(request(action, { cwd: source })),
		/persisted repository and base revision/,
	);
	supervisor.stop();
});

test("spawn defaults to read-only tools and permits explicit parent tools", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-toolbox-"));
	const runtime = await fauxRuntime(dir);
	const extensionPath = join(dir, "parent-extension.mjs");
	writeFileSync(extensionPath, "export default () => {};");
	const clock: Clock = {
		now: () => new Date("2026-09-18T10:00:00.000Z"),
		setTimeout: () => 0,
		clearTimeout: () => {},
	};
	const supervisor = new Supervisor({
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		clock,
		maxRunning: 0,
		modelRuntime: runtime,
	});
	const spawnAction = {
		action: "spawn",
		prompt: "use tools",
		model: { provider: "pi-tools-test", id: "test" },
		reasoning: "off",
		requestId: "default-tools",
	} as const;
	const base = request(spawnAction, {
		hostTools: [
			"read",
			"grep",
			"find",
			"ls",
			"bash",
			"edit",
			"write",
			"custom_parent_tool",
			"agent",
		],
		hostToolSources: [
			{ name: "custom_parent_tool", path: extensionPath },
			{ name: "agent", path: join(dir, "pi-tools.mjs") },
		],
	});
	const defaults = (await supervisor.handle(base)) as any;
	assert.deepEqual(defaults.effective.tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(defaults.effective.extensionPaths, undefined);
	assert.deepEqual(defaults.effective.limits, { runtimeSeconds: 3600 });
	const narrowed = (await supervisor.handle({
		...base,
		toolCallId: "second",
		action: {
			...spawnAction,
			tools: ["custom_parent_tool"],
			limits: { runtimeSeconds: 120 },
			requestId: "narrow-tools",
		},
	})) as any;
	assert.deepEqual(narrowed.effective.tools, ["custom_parent_tool"]);
	assert.deepEqual(narrowed.effective.extensionPaths, [extensionPath]);
	assert.deepEqual(narrowed.effective.limits, { runtimeSeconds: 120 });
	await assert.rejects(
		() =>
			supervisor.handle({
				...base,
				toolCallId: "third",
				action: { ...spawnAction, tools: ["agent"], requestId: "recursive" },
			}),
		/not allowed by the parent host/,
	);
	supervisor.stop();
});

test("catalog and spawn expose a persisted manual provider block before scheduling", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-admission-"));
	const runtime = await fauxRuntime(dir);
	const clock: Clock = {
		now: () => new Date("2026-09-18T10:00:00.000Z"),
		setTimeout: () => 0,
		clearTimeout: () => {},
	};
	const supervisor = new Supervisor({
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		clock,
		maxRunning: 0,
		modelRuntime: runtime,
	});
	const base = {
		action: "spawn",
		prompt: "first",
		model: { provider: "pi-tools-test", id: "test" },
		reasoning: "off",
		tools: [] as string[],
		requestId: "first",
	} as const;
	const first = (await supervisor.handle(request(base))) as any;
	await supervisor.handle(
		request(
			{ action: "stop", agentId: first.agentId },
			{ toolCallId: "stop-first" },
		),
	);
	supervisor.store.putCooldown({
		kind: "usage_exhausted",
		scopeKey: first.effective.scopeKey,
		provenance: "unknown",
		automaticRetryAllowed: true,
		attempts: 6,
		notBefore: "2026-09-18T09:00:00.000Z",
		updatedAt: clock.now().toISOString(),
	});

	const catalog = (await supervisor.handle(
		request({ action: "catalog", provider: "pi-tools-test" }),
	)) as any;
	assert.equal(catalog.models[0].scopeId, first.effective.scopeKey);
	assert.equal(catalog.scopes[0].admission.status, "manual_retry_required");
	assert.equal(catalog.scopes[0].admission.attempts, 6);

	const blocked = (await supervisor.handle(
		request({ ...base, prompt: "second", requestId: "second" }),
	)) as any;
	assert.equal(blocked.state, "blocked");
	assert.equal(blocked.reason, "quota_manual_resume_required");
	assert.equal(blocked.admission.status, "manual_retry_required");
	assert.match(blocked.message, /Do not spawn duplicates/);
	assert.equal(supervisor.store.getAgent(blocked.agentId)?.state, "blocked");
	assert.equal(supervisor.store.getRun(blocked.runId)?.state, "blocked");
	await assert.rejects(
		() =>
			supervisor.handle(
				request({ ...base, prompt: "third", requestId: "third" }),
			),
		/already has outstanding agent/,
	);
	const deliberatelyQueued = (await supervisor.handle(
		request({
			...base,
			prompt: "third",
			blockedPolicy: "enqueue",
			requestId: "third-enqueued",
		}),
	)) as any;
	assert.equal(deliberatelyQueued.state, "blocked");
	supervisor.stop();
});

test("catalog rejects an inexact provider filter and names exact providers", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-provider-"));
	const runtime = await fauxRuntime(dir);
	const supervisor = new Supervisor({
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		modelRuntime: runtime,
	});
	await supervisor.handle(
		request({ action: "catalog", provider: "pi-tools-test" }),
	);
	await assert.rejects(
		() =>
			supervisor.handle(request({ action: "catalog", provider: "pi-tools" })),
		/Available providers: pi-tools-test/,
	);
	supervisor.stop();
});

test("catalog prefers parent scoped models and falls back to all models", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-scoped-models-"));
	const runtime = await fauxRuntime(dir, ["provider-one"], ["first", "second"]);
	const supervisor = new Supervisor({
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		modelRuntime: runtime,
	});
	const scoped = (await supervisor.handle(
		request(
			{ action: "catalog" },
			{
				parentScopedModels: [
					{
						model: { provider: "provider-one", id: "second" },
						thinkingLevel: "off",
					},
				],
			},
		),
	)) as any;
	assert.equal(scoped.selection, "scoped");
	assert.deepEqual(
		scoped.models.map((model: any) => [model.provider, model.id]),
		[["provider-one", "second"]],
	);
	assert.equal(scoped.models[0].configuredReasoning, "off");
	assert.deepEqual(scoped.models[0].reasoning, ["off"]);

	const fallback = (await supervisor.handle(
		request({ action: "catalog" }),
	)) as any;
	assert.equal(fallback.selection, "all");
	assert.deepEqual(
		new Set(fallback.models.map((model: any) => model.provider)),
		new Set(["provider-one"]),
	);
	assert.deepEqual(
		new Set(fallback.models.map((model: any) => model.id)),
		new Set(["first", "second"]),
	);
	supervisor.stop();
});

test("research is loaded only through its exact extension when active in the parent", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-research-"));
	const runtime = await fauxRuntime(dir);
	const clock: Clock = {
		now: () => new Date("2026-09-18T10:00:00.000Z"),
		setTimeout: () => 0,
		clearTimeout: () => {},
	};
	const supervisor = new Supervisor({
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		clock,
		maxRunning: 0,
		modelRuntime: runtime,
	});
	const researchPath = join(
		process.cwd(),
		"..",
		"codex-research-tool",
		"index.ts",
	);
	const value = (await supervisor.handle(
		request(
			{
				action: "spawn",
				prompt: "research this",
				model: { provider: "pi-tools-test", id: "test" },
				reasoning: "off",
				tools: ["research"],
				requestId: "research",
			},
			{
				hostTools: ["research", "agent"],
				hostToolSources: [{ name: "research", path: researchPath }],
			},
		),
	)) as any;
	assert.deepEqual(value.effective.tools, ["research"]);
	assert.equal(value.effective.extensionPaths.length, 1);
	assert.match(
		value.effective.extensionPaths[0],
		/codex-research-tool\/index\.ts$/,
	);
	supervisor.stop();
});

test("usage checkpoints are visible during a run and included in terminal delivery", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(agent({ state: "running" }), "task");
	const usage = {
		input: 80,
		output: 20,
		cacheRead: 10,
		cacheWrite: 0,
		totalTokens: 100,
		cost: null,
	};
	await supervisor.workerEvent({
		agentId: "ag_test",
		runId: "run_test",
		generation: 1,
		type: "usage",
		usage,
	});
	const inspection = (await supervisor.handle(
		request({ action: "inspect", agentId: "ag_test" }),
	)) as any;
	assert.deepEqual(inspection.usage.currentRun, usage);
	await supervisor.workerEvent({
		agentId: "ag_test",
		runId: "run_test",
		generation: 1,
		type: "complete",
		summary: "done",
		outputTruncated: true,
		usage,
	});
	const notification = supervisor.store.pendingOutbox("parent-a")[0]
		?.payload as any;
	assert.deepEqual(notification.usage.currentRun, usage);
	assert.equal(notification.outputTruncated, true);
	supervisor.stop();
});

test("resume retries are idempotent and atomically claim the stale cooldown probe", async () => {
	const { supervisor, clock } = fixture();
	supervisor.store.insertAgent(
		agent({
			state: "blocked",
			reason: "usage_exhausted",
			error: { code: "quota_blocked", message: "blocked", retryable: false },
		}),
		"task",
	);
	supervisor.store.putCooldown({
		kind: "usage_exhausted",
		scopeKey: "scope-a",
		provenance: "unknown",
		automaticRetryAllowed: false,
		attempts: 6,
		updatedAt: clock.now().toISOString(),
	});
	const action = {
		action: "resume",
		agentId: "ag_test",
		prompt: "Try again after account recovery",
		requestId: "manual-retry",
	} as const;
	const first = (await supervisor.handle(request(action))) as any;
	const second = (await supervisor.handle(request(action))) as any;
	assert.equal(second.runId, first.runId);
	assert.equal(
		supervisor.store.getCooldown("scope-a")?.probeAgentId,
		"ag_test",
	);
	assert.equal(supervisor.store.countRuns("ag_test"), 2);
	supervisor.stop();
});

test("concurrent resumes configure every run but launch exactly one shared provider probe", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-concurrent-resume-"));
	const runtime = await fauxRuntime(dir);
	const clock: Clock = {
		now: () => new Date("2026-09-18T10:00:00.000Z"),
		setTimeout: () => 0,
		clearTimeout: () => {},
	};
	const supervisor = new Supervisor({
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		clock,
		maxRunning: 1,
		modelRuntime: runtime,
		launchWorker: () => ({ pid: process.pid }),
	});
	const scopeKey = stableHash(`pi-tools-test\0${dir}`).slice(0, 24);
	for (const index of [1, 2, 3])
		supervisor.store.insertAgent(
			agent({
				agentId: `ag_probe_${index}`,
				currentRunId: `run_probe_${index}`,
				state: "blocked",
				reason: "quota_manual_resume_required",
				error: { code: "quota_blocked", message: "blocked", retryable: false },
				config: {
					...agent().config,
					model: { provider: "pi-tools-test", id: "test" },
					scopeKey,
				},
			}),
			`task ${index}`,
		);
	supervisor.store.putCooldown({
		kind: "usage_exhausted",
		scopeKey,
		provenance: "unknown",
		automaticRetryAllowed: true,
		attempts: 6,
		updatedAt: clock.now().toISOString(),
	});

	const results = await Promise.all(
		[1, 2, 3].map(
			(index) =>
				supervisor.handle(
					request(
						{
							action: "resume",
							agentId: `ag_probe_${index}`,
							model: { provider: "pi-tools-test", id: "test" },
							reasoning: "off",
							requestId: `resume-${index}`,
						},
						{ toolCallId: `resume-call-${index}` },
					),
				) as Promise<any>,
		),
	);
	await supervisor.schedule();
	const probeOwner = supervisor.store.getCooldown(scopeKey)?.probeAgentId;
	assert(probeOwner);
	assert.equal(
		results.filter((value) => value.probeAgentId === value.agentId).length,
		1,
	);
	assert.equal(
		[1, 2, 3].filter(
			(index) =>
				supervisor.store.getAgent(`ag_probe_${index}`)?.state === "running",
		).length,
		1,
	);
	for (const index of [1, 2, 3])
		assert.equal(
			supervisor.store.getAgent(`ag_probe_${index}`)?.config.model.id,
			"test",
		);
	for (const value of results.filter((item) => item.agentId !== probeOwner)) {
		assert.equal(value.state, "blocked");
		assert.match(value.reason, /^waiting_for_shared_probe:/);
		assert.equal(supervisor.store.getRun(value.runId)?.state, "blocked");
	}
	const owner = supervisor.store.getAgent(probeOwner)!;
	await supervisor.workerEvent({
		agentId: owner.agentId,
		runId: owner.currentRunId,
		generation: owner.generation,
		type: "complete",
		summary: "probe succeeded",
		usage: {},
	});
	assert.equal(supervisor.store.getCooldown(scopeKey), undefined);
	assert.equal(
		[1, 2, 3].some((index) =>
			supervisor.store
				.getAgent(`ag_probe_${index}`)
				?.reason?.startsWith("waiting_for_shared_probe"),
		),
		false,
	);
	supervisor.stop();
});

test("resume updates the admission scope when the provider changes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-resume-scope-"));
	const runtime = await fauxRuntime(dir, ["pi-tools-test", "pi-tools-other"]);
	const supervisor = new Supervisor({
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		maxRunning: 0,
		modelRuntime: runtime,
	});
	supervisor.store.insertAgent(
		agent({ state: "completed", resultSummary: "done" }),
		"task",
	);

	const resumed = (await supervisor.handle(
		request({
			action: "resume",
			agentId: "ag_test",
			model: { provider: "pi-tools-other", id: "test" },
			reasoning: "off",
			requestId: "change-provider",
		}),
	)) as any;

	assert.equal(resumed.effective.model.provider, "pi-tools-other");
	assert.equal(
		resumed.effective.scopeKey,
		stableHash(`pi-tools-other\0${dir}`).slice(0, 24),
	);
	assert.equal(
		supervisor.store.getAgent("ag_test")?.config.scopeKey,
		resumed.effective.scopeKey,
	);
	supervisor.stop();
});

test("a failed recovery probe releases its atomic ownership claim", async () => {
	const { supervisor, clock } = fixture();
	supervisor.store.insertAgent(
		agent({ state: "blocked", reason: "quota_manual_resume_required" }),
		"task",
	);
	supervisor.store.putCooldown({
		kind: "usage_exhausted",
		scopeKey: "scope-a",
		provenance: "unknown",
		automaticRetryAllowed: true,
		attempts: 6,
		updatedAt: clock.now().toISOString(),
	});
	const resumed = (await supervisor.handle(
		request({
			action: "resume",
			agentId: "ag_test",
			requestId: "failed-probe",
		}),
	)) as any;
	assert.equal(
		supervisor.store.getCooldown("scope-a")?.probeAgentId,
		"ag_test",
	);
	const running = supervisor.store.getAgent("ag_test")!;

	await supervisor.workerEvent({
		agentId: "ag_test",
		runId: resumed.runId,
		generation: running.generation,
		type: "failed",
		code: "synthetic",
		message: "probe failed",
		retryable: false,
	});

	assert.equal(
		supervisor.store.getCooldown("scope-a")?.probeAgentId,
		undefined,
	);
	supervisor.stop();
});

test("uncertain side effects require atomic retry or skip decisions before resume", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(
		agent({
			state: "blocked",
			reason: "uncertain_side_effects",
			error: {
				code: "recovery_required",
				message: "uncertain",
				retryable: false,
			},
		}),
		"task",
	);
	supervisor.store.toolStart(
		"ag_test",
		"run_test",
		1,
		"call-write",
		"write",
		"hash",
		"2026-01-01T00:00:00.000Z",
	);
	await assert.rejects(
		() =>
			supervisor.handle(
				request({
					action: "resume",
					agentId: "ag_test",
					prompt: "continue",
					requestId: "unsafe",
				}),
			),
		/reconcile tool call-write/,
	);
	assert.equal(
		supervisor.store.uncertainTools("ag_test", "run_test").length,
		1,
	);
	const resumed = (await supervisor.handle(
		request({
			action: "resume",
			agentId: "ag_test",
			prompt: "reconcile tool call-write: skip\nContinue without repeating it.",
			requestId: "safe",
		}),
	)) as any;
	assert.match(resumed.runId, /^run_/);
	assert.equal(
		supervisor.store.uncertainTools("ag_test", "run_test").length,
		0,
	);
	supervisor.stop();
});

test("repeated pause is a no-op once pause intent is durable", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(
		agent({ state: "paused", desiredState: "paused" }),
		"task",
	);
	const first = (await supervisor.handle(
		request({ action: "pause", agentId: "ag_test" }),
	)) as any;
	const second = (await supervisor.handle(
		request({ action: "pause", agentId: "ag_test" }),
	)) as any;
	assert.deepEqual(second, first);
	assert.equal(supervisor.store.events(["ag_test"], 0).length, 0);
	supervisor.stop();
});

test("stop intent wins over a late worker completion", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(agent({ state: "running" }), "task");
	await supervisor.handle(request({ action: "stop", agentId: "ag_test" }));
	await supervisor.workerEvent({
		agentId: "ag_test",
		runId: "run_test",
		generation: 1,
		type: "complete",
		summary: "useful late result",
		usage: {},
	});
	const stopped = supervisor.store.getAgent("ag_test")!;
	assert.equal(stopped.state, "stopped");
	assert.equal(stopped.resultSummary, "useful late result");
	supervisor.stop();
});

test("duplicate terminal worker reports emit only one parent notification", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(
		agent({
			state: "stopping",
			desiredState: "stopped",
			reason: "user stop",
		}),
		"task",
	);
	const report = {
		agentId: "ag_test",
		runId: "run_test",
		generation: 1,
		type: "paused",
	};
	await supervisor.workerEvent(report);
	await supervisor.workerEvent(report);

	assert.equal(
		supervisor.store
			.events(["ag_test"], 0)
			.filter((event) => event.type === "stopped").length,
		1,
	);
	assert.equal(supervisor.store.pendingOutbox("parent-a").length, 1);
	supervisor.stop();
});

test("pause and stop intent win over every late terminal worker event", async () => {
	for (const type of ["paused", "availability", "failed"] as const) {
		const { supervisor } = fixture();
		supervisor.store.insertAgent(
			agent({
				state: "stopping",
				desiredState: "stopped",
				reason: "user stop",
			}),
			"task",
		);
		const event =
			type === "availability"
				? {
						type,
						block: {
							kind: "usage_exhausted",
							scopeKey: "scope-a",
							provenance: "unknown",
							automaticRetryAllowed: true,
						},
					}
				: type === "failed"
					? {
							type,
							code: "synthetic",
							message: "late failure",
							retryable: false,
						}
					: { type };
		await supervisor.workerEvent({
			agentId: "ag_test",
			runId: "run_test",
			generation: 1,
			...event,
		});
		assert.equal(
			supervisor.store.getAgent("ag_test")?.state,
			"stopped",
			`${type} must not override stop`,
		);
		assert.equal(supervisor.store.getAgent("ag_test")?.desiredState, "stopped");
		supervisor.stop();
	}

	const { supervisor } = fixture();
	supervisor.store.insertAgent(
		agent({
			state: "pausing",
			desiredState: "paused",
			reason: "user_interrupt_pause",
		}),
		"task",
	);
	await supervisor.workerEvent({
		agentId: "ag_test",
		runId: "run_test",
		generation: 1,
		type: "availability",
		block: {
			kind: "usage_exhausted",
			scopeKey: "scope-a",
			provenance: "unknown",
			automaticRetryAllowed: true,
		},
	});
	assert.equal(supervisor.store.getAgent("ag_test")?.state, "paused");
	assert.equal(supervisor.store.getAgent("ag_test")?.desiredState, "paused");
	supervisor.stop();
});

test("worker output, summaries, and failures are redacted at the supervisor boundary", async () => {
	const secret = "sk-abcdefghijklmno";
	for (const event of [
		{ type: "output", text: `chunk ${secret}` },
		{ type: "complete", summary: `done with ${secret}`, usage: {} },
		{
			type: "failed",
			code: "synthetic",
			message: `failed with ${secret}`,
			retryable: false,
		},
	]) {
		const { supervisor } = fixture();
		supervisor.store.insertAgent(agent({ state: "running" }), "task");
		await supervisor.workerEvent({
			agentId: "ag_test",
			runId: "run_test",
			generation: 1,
			...event,
		});
		const record = supervisor.store.getAgent("ag_test")!;
		if (event.type === "output")
			assert.doesNotMatch(
				record.resultPath ? readFileSync(record.resultPath, "utf8") : "",
				/abcdefghijklmno/,
			);
		else if (event.type === "complete")
			assert.equal(record.resultSummary, "done with [redacted]");
		else assert.equal(record.error?.message, "failed with [redacted]");
		supervisor.stop();
	}
});

test("inspect does not expose child transcripts or accumulated output artifacts", async () => {
	const { supervisor } = fixture();
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-output-"));
	const resultPath = join(dir, "agent.log");
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(resultPath, "private accumulated output\n");
	writeFileSync(sessionFile, "private transcript\n");
	supervisor.store.insertAgent(
		agent({ state: "completed", resultPath, sessionFile }),
		"task",
	);
	const inspection = (await supervisor.handle(
		request({ action: "inspect", agentId: "ag_test" }),
	)) as any;
	assert.equal(inspection.output, undefined);
	assert.equal(inspection.nextCursor, undefined);
	assert.equal(inspection.session.file, undefined);
	assert.equal(inspection.diagnostics.resultPath, undefined);
	assert.doesNotMatch(
		JSON.stringify(inspection),
		/private accumulated output|private transcript/,
	);
	supervisor.stop();
});

test("shared cooldown admits exactly one probe and leaves user-paused work paused", async () => {
	const { supervisor, clock } = fixture();
	const first = agent({
		agentId: "ag_1",
		currentRunId: "run_1",
		state: "blocked",
		reason: "waiting_for_quota",
	});
	const second = agent({
		agentId: "ag_2",
		currentRunId: "run_2",
		state: "blocked",
		reason: "waiting_for_quota",
	});
	const paused = agent({
		agentId: "ag_3",
		currentRunId: "run_3",
		state: "paused",
		desiredState: "paused",
	});
	supervisor.store.insertAgent(first, "continue one");
	supervisor.store.insertAgent(second, "continue two");
	supervisor.store.insertAgent(paused, "paused");
	supervisor.store.putCooldown({
		kind: "usage_exhausted",
		scopeKey: "scope-a",
		provenance: "unknown",
		automaticRetryAllowed: true,
		attempts: 1,
		notBefore: clock.now().toISOString(),
		updatedAt: clock.now().toISOString(),
	});
	await supervisor.schedule();
	const running = ["ag_1", "ag_2"].filter(
		(id) => supervisor.store.getAgent(id)?.state === "running",
	);
	assert.equal(running.length, 1);
	const launched = supervisor.store.getAgent(running[0]!)!;
	assert.equal(
		supervisor.store.getRunGeneration(launched.currentRunId),
		launched.generation,
	);
	assert.equal(supervisor.store.getAgent("ag_3")?.state, "paused");
	supervisor.stop();
});

test("known multi-hour reset survives restart and machine sleep without wall-clock waiting", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-restart-"));
	let current = new Date("2026-09-18T10:00:00.000Z");
	let launches = 0;
	const clock: Clock = {
		now: () => current,
		setTimeout: () => 0,
		clearTimeout: () => {},
	};
	const options = {
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		clock,
		jitter: () => 0,
		launchWorker: () => {
			launches++;
			return { pid: process.pid };
		},
	};
	let supervisor = new Supervisor(options);
	const record = agent({ state: "blocked", reason: "waiting_for_quota" });
	supervisor.store.insertAgent(record, "continue");
	supervisor.store.putCooldown({
		kind: "usage_exhausted",
		scopeKey: "scope-a",
		retryAt: "2026-09-18T15:00:00.000Z",
		provenance: "provider_reset",
		automaticRetryAllowed: true,
		attempts: 1,
		notBefore: "2026-09-18T15:00:00.000Z",
		updatedAt: current.toISOString(),
	});
	await supervisor.schedule();
	assert.equal(launches, 0);
	supervisor.stop();
	current = new Date("2026-09-18T16:00:00.000Z");
	supervisor = new Supervisor(options);
	await supervisor.schedule();
	assert.equal(launches, 1);
	assert.equal(
		supervisor.store.getCooldown("scope-a")?.probeAgentId,
		"ag_test",
	);
	supervisor.stop();
});

test("wait subscribes before checking and wakes on a racing terminal event", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(agent({ state: "running" }), "task");
	const pending = supervisor.handle(
		request({
			action: "wait",
			agentIds: ["ag_test"],
			afterEventId: 0,
			timeoutMs: 60_000,
		}),
	) as Promise<any>;
	await supervisor.workerEvent({
		agentId: "ag_test",
		runId: "run_test",
		generation: 1,
		type: "failed",
		code: "synthetic",
		message: "failure",
		retryable: false,
	});
	const value = await pending;
	assert.equal(value.timedOut, false);
	assert.equal(value.events.at(-1).type, "failed");
	supervisor.stop();
});

test("idle persists an all-agent barrier and emits one aggregate notification", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(
		agent({ agentId: "ag_1", currentRunId: "run_1", state: "running" }),
		"one",
	);
	supervisor.store.insertAgent(
		agent({ agentId: "ag_2", currentRunId: "run_2", state: "running" }),
		"two",
	);
	const armed = (await supervisor.handle(
		request({ action: "idle", agentIds: ["ag_1", "ag_2"], requestId: "group" }),
	)) as any;
	assert.equal(armed.state, "armed");
	await supervisor.workerEvent({
		agentId: "ag_1",
		runId: "run_1",
		generation: 1,
		type: "complete",
		summary: "first result",
		usage: {},
	});
	assert.equal(supervisor.store.pendingOutbox("parent-a").length, 0);
	await supervisor.workerEvent({
		agentId: "ag_2",
		runId: "run_2",
		generation: 1,
		type: "complete",
		summary: "second result",
		usage: {},
	});
	const notifications = supervisor.store.pendingOutbox("parent-a");
	assert.equal(notifications.length, 1);
	const payload = notifications[0]?.payload as any;
	assert.equal(payload.kind, "idle_resolved");
	assert.equal(payload.resolution, "all_settled");
	assert.deepEqual(
		payload.agents.map((value: any) => value.summary),
		["first result", "second result"],
	);
	assert.equal(supervisor.store.getIdle(armed.idleId)?.state, "resolved");
	const replay = (await supervisor.handle(
		request({ action: "idle", agentIds: ["ag_1", "ag_2"], requestId: "group" }),
	)) as any;
	assert.equal(replay.state, "resolved");
	supervisor.stop();
});

test("idle completion policies resolve at their documented boundaries", async () => {
	const cases = [
		{
			until: "any_settled",
			terminal: ["completed"],
			resolution: "any_settled",
		},
		{
			until: "quorum",
			quorum: 2,
			terminal: ["completed", "completed"],
			resolution: "quorum",
		},
		{
			until: "all_succeeded",
			terminal: ["failed"],
			resolution: "first_failure",
		},
		{
			until: "first_failure",
			terminal: ["failed"],
			resolution: "first_failure",
		},
	] as const;
	for (const [caseIndex, item] of cases.entries()) {
		const { supervisor } = fixture();
		for (let index = 0; index < 3; index++)
			supervisor.store.insertAgent(
				agent({
					agentId: `ag_${caseIndex}_${index}`,
					currentRunId: `run_${caseIndex}_${index}`,
					state: "running",
				}),
				"task",
			);
		const action = {
			action: "idle",
			agentIds: [0, 1, 2].map((index) => `ag_${caseIndex}_${index}`),
			until: item.until,
			...(item.until === "quorum" ? { quorum: item.quorum } : {}),
			requestId: `policy-${caseIndex}`,
		} as const;
		const armed = (await supervisor.handle(request(action))) as any;
		for (const [index, state] of item.terminal.entries())
			await supervisor.workerEvent({
				agentId: `ag_${caseIndex}_${index}`,
				runId: `run_${caseIndex}_${index}`,
				generation: 1,
				type: state === "completed" ? "complete" : "failed",
				...(state === "completed"
					? { summary: "done", usage: {} }
					: { code: "synthetic", message: "failed", retryable: false }),
			});
		assert.equal(
			supervisor.store.getIdle(armed.idleId)?.resolution,
			item.resolution,
		);
		supervisor.stop();
	}
});

test("idle barriers can be listed, inspected, updated, cancelled, and changed by parent activity", async () => {
	const { supervisor } = fixture();
	for (let index = 1; index <= 3; index++)
		supervisor.store.insertAgent(
			agent({
				agentId: `ag_${index}`,
				currentRunId: `run_${index}`,
				state: "running",
			}),
			"task",
		);
	const armed = (await supervisor.handle(
		request({
			action: "idle",
			agentIds: ["ag_1", "ag_2"],
			activityPolicy: "keep",
			requestId: "controls",
		}),
	)) as any;
	const updated = (await supervisor.handle(
		request({
			action: "idle_update",
			idleId: armed.idleId,
			removeAgentIds: ["ag_2"],
			addAgentIds: ["ag_3"],
			requestId: "swap",
		}),
	)) as any;
	assert.deepEqual(
		updated.agents.map((value: any) => value.agentId),
		["ag_1", "ag_3"],
	);
	assert.equal(
		(
			(await supervisor.handle(
				request({ action: "idle_list", state: "pending" }),
			)) as any
		).idles.length,
		1,
	);
	assert.deepEqual(
		(
			(await supervisor.handle(
				request({ action: "idle_inspect", idleId: armed.idleId }),
			)) as any
		).agents.map((value: any) => value.agentId),
		["ag_1", "ag_3"],
	);
	assert.equal(
		(
			(await supervisor.handle(
				request({
					action: "idle_cancel",
					idleId: armed.idleId,
					requestId: "cancel",
				}),
			)) as any
		).state,
		"cancelled",
	);

	const cancelOnInput = (await supervisor.handle(
		request({
			action: "idle",
			agentIds: ["ag_1"],
			activityPolicy: "cancel",
			requestId: "activity-cancel",
		}),
	)) as any;
	const notifyOnly = (await supervisor.handle(
		request({
			action: "idle",
			agentIds: ["ag_2"],
			activityPolicy: "notify_only",
			requestId: "activity-notify",
		}),
	)) as any;
	supervisor.parentInput({ parentSessionId: "parent-a" });
	assert.equal(
		supervisor.store.getIdle(cancelOnInput.idleId)?.state,
		"cancelled",
	);
	assert.equal(
		supervisor.store.getIdle(notifyOnly.idleId)?.wakeMode,
		"notify_only",
	);
	supervisor.stop();
});

test("inspect_many exposes diagnostics but no child output", async () => {
	const { supervisor } = fixture();
	const ids = ["ag_many_1", "ag_many_2"];
	for (const [index, agentId] of ids.entries())
		supervisor.store.insertAgent(
			agent({
				agentId,
				currentRunId: `run_many_${index}`,
				state: "completed",
			}),
			"task",
		);
	const value = (await supervisor.handle(
		request({ action: "inspect_many", agentIds: ids }),
	)) as any;
	assert.equal(value.agents.length, 2);
	assert.equal(
		value.agents.some((item: any) => "output" in item),
		false,
	);
	assert.equal("outputLimitBytes" in value, false);
	assert.equal("truncated" in value, false);
	supervisor.stop();
});

test("continue_headless launches once after a quit and persists fenced completion", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-headless-"));
	const sessionFile = join(dir, "parent.jsonl");
	writeFileSync(sessionFile, "");
	const clock: Clock = {
		now: () => new Date("2026-09-18T10:00:00.000Z"),
		setTimeout: () => 0,
		clearTimeout: () => {},
	};
	const launches: string[] = [];
	const supervisor = new Supervisor({
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		clock,
		launchWorker: () => ({ pid: process.pid }),
		launchHeadless: (path) => {
			launches.push(path);
			return { pid: process.pid };
		},
	});
	const resultPath = join(dir, "accumulated.log");
	writeFileSync(resultPath, "private prior child output");
	supervisor.store.insertAgent(agent({ state: "running", resultPath }), "task");
	const armed = (await supervisor.handle(
		request(
			{
				action: "idle",
				agentIds: ["ag_test"],
				disconnectPolicy: "continue_headless",
			},
			{
				parent: { sessionId: "parent-a", sessionFile, branchAnchor: "leaf-a" },
			},
		),
	)) as any;
	supervisor.parentDetach({ parentSessionId: "parent-a", reason: "quit" });
	await supervisor.workerEvent({
		agentId: "ag_test",
		runId: "run_test",
		generation: 1,
		type: "complete",
		summary: "result",
		usage: {},
	});
	assert.equal(launches.length, 1);
	const config = JSON.parse(readFileSync(launches[0]!, "utf8"));
	assert.equal(config.idleId, armed.idleId);
	assert.match(config.prompt, /Agent ag_test/);
	assert.match(config.prompt, /Final result excerpt: result/);
	assert.doesNotMatch(config.prompt, /private prior child output/);
	supervisor.headlessEvent({
		idleId: armed.idleId,
		headlessRunId: config.headlessRunId,
		parentSessionId: "parent-a",
		type: "complete",
	});
	assert.equal(
		supervisor.store.getIdle(armed.idleId)?.headlessState,
		"completed",
	);
	supervisor.parentDetach({ parentSessionId: "parent-a", reason: "quit" });
	assert.equal(launches.length, 1);
	supervisor.stop();
});

test("idle supersedes an undelivered member notification before arming", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(
		agent({ agentId: "ag_1", currentRunId: "run_1", state: "running" }),
		"one",
	);
	supervisor.store.insertAgent(
		agent({ agentId: "ag_2", currentRunId: "run_2", state: "running" }),
		"two",
	);
	await supervisor.workerEvent({
		agentId: "ag_1",
		runId: "run_1",
		generation: 1,
		type: "complete",
		summary: "first result",
		usage: {},
	});
	assert.equal(supervisor.store.pendingOutbox("parent-a").length, 1);
	const armed = (await supervisor.handle(
		request({ action: "idle", agentIds: ["ag_1", "ag_2"] }),
	)) as any;
	assert.equal(armed.state, "armed");
	assert.equal(supervisor.store.pendingOutbox("parent-a").length, 0);
	await supervisor.workerEvent({
		agentId: "ag_2",
		runId: "run_2",
		generation: 1,
		type: "complete",
		summary: "second result",
		usage: {},
	});
	assert.equal(supervisor.store.pendingOutbox("parent-a").length, 1);
	supervisor.stop();
});

test("idle resolves early when an agent requires nonrecoverable attention", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(agent({ state: "running" }), "task");
	const armed = (await supervisor.handle(
		request({ action: "idle", agentIds: ["ag_test"] }),
	)) as any;
	await supervisor.workerEvent({
		agentId: "ag_test",
		runId: "run_test",
		generation: 1,
		type: "availability",
		block: {
			kind: "auth_required",
			scopeKey: "scope-a",
			provenance: "unknown",
			automaticRetryAllowed: false,
		},
	});
	const notification = supervisor.store.pendingOutbox("parent-a")[0]
		?.payload as any;
	assert.equal(
		supervisor.store.getIdle(armed.idleId)?.resolution,
		"attention_required",
	);
	assert.equal(notification.kind, "idle_resolved");
	assert.equal(notification.resolution, "attention_required");
	supervisor.stop();
});

test("idle remains armed through an automatically recoverable quota block", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(agent({ state: "running" }), "task");
	const armed = (await supervisor.handle(
		request({ action: "idle", agentIds: ["ag_test"] }),
	)) as any;
	await supervisor.workerEvent({
		agentId: "ag_test",
		runId: "run_test",
		generation: 1,
		type: "availability",
		block: {
			kind: "usage_exhausted",
			scopeKey: "scope-a",
			retryAt: "2026-09-18T11:00:00.000Z",
			provenance: "provider_reset",
			automaticRetryAllowed: true,
		},
	});
	assert.equal(supervisor.store.getIdle(armed.idleId)?.state, "pending");
	assert.equal(supervisor.store.pendingOutbox("parent-a").length, 0);
	supervisor.stop();
});

test("idle resolves immediately without scheduling a redundant wakeup", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(
		agent({ state: "completed", resultSummary: "done" }),
		"task",
	);
	const value = (await supervisor.handle(
		request({ action: "idle", agentIds: ["ag_test"] }),
	)) as any;
	assert.equal(value.state, "resolved");
	assert.equal(value.resolution, "all_settled");
	assert.equal(value.agents[0].outputTruncated, false);
	assert.equal(supervisor.store.pendingOutbox("parent-a").length, 0);
	supervisor.stop();
});

test("startup reevaluates and delivers a pending idle barrier", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-idle-restart-"));
	const clock: Clock = {
		now: () => new Date("2026-09-18T10:00:00.000Z"),
		setTimeout: () => 0,
		clearTimeout: () => {},
	};
	const options = {
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		clock,
		launchWorker: () => ({ pid: process.pid }),
	};
	let supervisor = new Supervisor(options);
	const completed = agent({
		state: "completed",
		resultSummary: "persisted result",
	});
	supervisor.store.insertAgent(completed, "task");
	supervisor.store.insertIdle(
		{
			idleId: "idle_restart",
			parentSessionId: "parent-a",
			state: "pending",
			until: "all_settled",
			activityPolicy: "keep",
			wakeMode: "auto",
			disconnectPolicy: "defer",
			headlessState: "none",
			createdAt: completed.createdAt,
		},
		[completed.agentId],
	);
	supervisor.stop();
	supervisor = new Supervisor(options);
	await supervisor.start();
	assert.equal(supervisor.store.getIdle("idle_restart")?.state, "resolved");
	const pending = supervisor.store.pendingOutbox("parent-a")[0];
	assert(pending);
	assert.equal((pending.payload as any).kind, "idle_resolved");
	supervisor.stop();
});

test("ownership prevents delivery and control from a different parent session", async () => {
	const { supervisor } = fixture();
	supervisor.store.insertAgent(agent(), "task");
	await assert.rejects(
		() =>
			supervisor.handle(
				request(
					{ action: "inspect", agentId: "ag_test" },
					{ parent: { sessionId: "other-parent" } },
				),
			),
		/does not belong/,
	);
	supervisor.stop();
});

test("startup crash recovery repeats reads but blocks uncertain writes", async () => {
	const readFixture = fixture();
	const readAgent = agent({ state: "running", workerPid: 99_999_991 });
	readFixture.supervisor.store.insertAgent(readAgent, "task");
	readFixture.supervisor.store.toolStart(
		readAgent.agentId,
		readAgent.currentRunId,
		readAgent.generation,
		"call-read",
		"read",
		"hash",
		readAgent.createdAt,
	);
	await readFixture.supervisor.start();
	assert.equal(
		readFixture.supervisor.store.getAgent(readAgent.agentId)?.state,
		"recovering",
	);
	readFixture.supervisor.stop();

	const writeFixture = fixture();
	const writeAgent = agent({ state: "running", workerPid: 99_999_992 });
	writeFixture.supervisor.store.insertAgent(writeAgent, "task");
	writeFixture.supervisor.store.toolStart(
		writeAgent.agentId,
		writeAgent.currentRunId,
		writeAgent.generation,
		"call-write",
		"write",
		"hash",
		writeAgent.createdAt,
	);
	await writeFixture.supervisor.start();
	const blocked = writeFixture.supervisor.store.getAgent(writeAgent.agentId)!;
	assert.equal(blocked.state, "blocked");
	assert.equal(blocked.reason, "uncertain_side_effects");
	assert.equal(
		writeFixture.supervisor.store.pendingOutbox(writeAgent.parentSessionId)
			.length,
		1,
	);
	writeFixture.supervisor.stop();
});

test("startup removes orphaned worker launch artifacts", async () => {
	const { supervisor } = fixture();
	const stateDir = (supervisor as any).options.stateDir as string;
	const configDir = join(stateDir, "worker-config");
	const logDir = join(stateDir, "worker-logs");
	mkdirSync(configDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });
	const configPath = join(configDir, "orphan.json");
	const logPath = join(logDir, "orphan.log");
	writeFileSync(configPath, "{}");
	writeFileSync(logPath, "failed");

	await supervisor.start();

	assert.equal(existsSync(configPath), false);
	assert.equal(existsSync(logPath), false);
	supervisor.stop();
});

test("repeated worker crashes fail instead of restarting forever", () => {
	const { supervisor } = fixture();
	const record = agent({
		state: "running",
		generation: 3,
		workerPid: 99_999_993,
	});
	supervisor.store.insertAgent(record, "task");
	for (let generation = 1; generation <= 3; generation++)
		supervisor.store.addEvent(
			record.agentId,
			record.currentRunId,
			"worker_started",
			{ generation },
			record.createdAt,
		);

	(supervisor as any).recoverDead(
		record,
		"worker_exit:1",
		"Cannot find module worker-entry.ts",
	);

	const failed = supervisor.store.getAgent(record.agentId)!;
	assert.equal(failed.state, "failed");
	assert.equal(failed.reason, "worker_crash_loop");
	assert.equal(failed.error?.code, "worker_crash_loop");
	assert.match(
		failed.error?.message ?? "",
		/Cannot find module worker-entry\.ts/,
	);
	assert.equal(
		supervisor.store.pendingOutbox(record.parentSessionId).length,
		1,
	);
	supervisor.stop();
});

test("an expired live-worker lease is terminated before recovery", async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
	});
	assert.ok(child.pid);
	const exited = new Promise<void>((resolve) =>
		child.once("exit", () => resolve()),
	);
	const { supervisor } = fixture();
	const record = agent({
		state: "running",
		workerPid: child.pid,
		leaseUntil: "2026-09-18T09:59:00.000Z",
	});
	supervisor.store.insertAgent(record, "task");
	try {
		await supervisor.start();
		assert.equal(supervisor.store.getAgent(record.agentId)?.state, "stopping");
		assert.equal(
			supervisor.store.getAgent(record.agentId)?.reason,
			"stale_worker_lease",
		);
		await exited;
		await (supervisor as any).reconcileLiveWorkers();
		assert.equal(
			supervisor.store.getAgent(record.agentId)?.state,
			"recovering",
		);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		supervisor.stop();
	}
});

test("a queued child with a missing workspace blocks visibly without launching", async () => {
	const { supervisor } = fixture();
	const missing = join(
		tmpdir(),
		`pi-tools-missing-${Date.now()}-${Math.random()}`,
	);
	const record = agent({
		config: {
			...configForTest(),
			cwd: missing,
			workspace: { mode: "worktree", path: missing, baseRevision: "deadbeef" },
		},
	});
	supervisor.store.insertAgent(record, "task");
	await supervisor.schedule();
	assert.equal(supervisor.store.getAgent(record.agentId)?.state, "blocked");
	assert.equal(
		supervisor.store.getAgent(record.agentId)?.reason,
		"missing_workspace",
	);
	assert.equal(
		supervisor.store.pendingOutbox(record.parentSessionId).length,
		1,
	);
	supervisor.stop();
});

test("queue saturation rejects before model lookup and commits no idempotency record", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tools-queue-"));
	const clock: Clock = {
		now: () => new Date("2026-09-18T10:00:00.000Z"),
		setTimeout: () => 0,
		clearTimeout: () => {},
	};
	const supervisor = new Supervisor({
		agentDir: dir,
		stateDir: dir,
		socketPath: join(dir, "socket"),
		tokenPath: join(dir, "token"),
		clock,
		maxOutstandingPerParent: 1,
		launchWorker: () => ({ pid: process.pid }),
	});
	supervisor.store.insertAgent(agent(), "task");
	await assert.rejects(
		() =>
			supervisor.handle(
				request({
					action: "spawn",
					prompt: "another",
					model: { provider: "faux", id: "test" },
					requestId: "queue-test",
				}),
			),
		/already has 1 outstanding/,
	);
	assert.equal(
		supervisor.store.getIdempotency("parent-a", "spawn:queue-test"),
		undefined,
	);
	supervisor.stop();
});

function configForTest() {
	return agent().config;
}
