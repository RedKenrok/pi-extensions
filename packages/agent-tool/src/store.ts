import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	AgentRecord,
	AgentState,
	AvailabilityBlock,
	DeliveryKind,
	EventRecord,
	IdleActivityPolicy,
	IdleBarrierRecord,
	IdleResolution,
	IdleState,
	NormalizedError,
	RuntimeLimits,
	UsageReport,
	UsageTotals,
} from "./types.ts";

export const STATE_VERSION = 1;
const STATE_FORMAT = "agent-tool-state";

type Envelope<T> = {
	format: typeof STATE_FORMAT;
	version: typeof STATE_VERSION;
	kind: string;
	data: T;
};

interface RunRecord {
	runId: string;
	agentId: string;
	generation: number;
	prompt: string;
	state: string;
	startedAt?: string;
	finishedAt?: string;
	usage?: UsageTotals;
	error?: NormalizedError;
	createdAt: string;
}
export interface MessageRecord {
	messageId: string;
	agentId: string;
	runId: string;
	delivery: DeliveryKind;
	text: string;
	state: "queued" | "submitted" | "applied";
	sequence: number;
	createdAt: string;
}
interface ToolOperation {
	agentId: string;
	runId: string;
	generation: number;
	toolCallId: string;
	toolName: string;
	argsHash: string;
	state: string;
	startedAt: string;
	finishedAt?: string;
}
export interface CooldownRecord extends AvailabilityBlock {
	notBefore?: string;
	attempts: number;
	probeAgentId?: string;
	updatedAt: string;
}
interface IdempotencyRecord {
	scope: string;
	key: string;
	payloadHash: string;
	response: unknown;
	createdAt: string;
}
interface OutboxRecord {
	eventId: number;
	parentSessionId: string;
	agentId: string;
	payload: unknown;
	state: "pending" | "delivered" | "superseded";
	attempts: number;
	createdAt: string;
	deliveredAt?: string;
}
interface ParentBridge {
	parentSessionId: string;
	branchAnchor?: string;
	attachedAt: string;
	lastAckEventId: number;
	attached: boolean;
	detachedAt?: string;
	detachReason?: string;
}
interface GlobalState {
	nextEventId: number;
	runs: RunRecord[];
	messages: MessageRecord[];
	events: EventRecord[];
	idempotency: IdempotencyRecord[];
	toolOperations: ToolOperation[];
	cooldowns: CooldownRecord[];
	outbox: OutboxRecord[];
	parents: ParentBridge[];
}
interface IdleFile {
	barrier: IdleBarrierRecord;
	agentIds: string[];
}

type AgentUpdate = {
	[K in keyof Pick<
		AgentRecord,
		| "state"
		| "desiredState"
		| "reason"
		| "generation"
		| "currentRunId"
		| "sessionId"
		| "sessionFile"
		| "workerPid"
		| "leaseUntil"
		| "checkpoint"
		| "resultPath"
		| "resultSummary"
		| "error"
		| "config"
	>]?: AgentRecord[K] | undefined;
} & { updatedAt: string };

function emptyGlobal(): GlobalState {
	return {
		nextEventId: 1,
		runs: [],
		messages: [],
		events: [],
		idempotency: [],
		toolOperations: [],
		cooldowns: [],
		outbox: [],
		parents: [],
	};
}
function emptyUsage(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: null,
	};
}
function addUsage(target: UsageTotals, value: UsageTotals): void {
	target.input += Number(value.input ?? 0);
	target.output += Number(value.output ?? 0);
	target.cacheRead += Number(value.cacheRead ?? 0);
	target.cacheWrite += Number(value.cacheWrite ?? 0);
	target.totalTokens += Number(value.totalTokens ?? 0);
	if (value.cost !== null && value.cost !== undefined)
		target.cost = (target.cost ?? 0) + Number(value.cost);
}
function envelope<T>(kind: string, data: T): Envelope<T> {
	return {
		format: STATE_FORMAT,
		version: STATE_VERSION,
		kind,
		data,
	};
}
function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(temporary, path);
	try {
		chmodSync(path, 0o600);
	} catch {
		/* best effort on non-POSIX */
	}
}

export class StateVersionError extends Error {
	readonly code = "state_version_mismatch";
	readonly retryable = false;
	readonly restartRequired = true;
	constructor(found: string) {
		super(
			`Agent state version ${found} does not match required version ${STATE_VERSION}. Disposable agent state has been cleared. Restart Pi and repeat the original request; previous agents will not be recovered.`,
		);
		this.name = "StateVersionError";
	}
}

/** Validate or initialize the disposable state directory before supervisor startup. */
export function prepareStateDirectory(path: string): void {
	const manifestPath = join(path, "manifest.json");
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		writeJson(manifestPath, envelope("manifest", {}));
		return;
	}
	if (!existsSync(manifestPath)) {
		if (readdirSync(path).length === 0) {
			writeJson(manifestPath, envelope("manifest", {}));
			return;
		}
		rmSync(path, { recursive: true, force: true });
		throw new StateVersionError("missing");
	}
	let manifest: Partial<Envelope<unknown>>;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<
			Envelope<unknown>
		>;
	} catch {
		rmSync(path, { recursive: true, force: true });
		throw new StateVersionError("invalid");
	}
	if (
		manifest.format !== STATE_FORMAT ||
		manifest.version !== STATE_VERSION ||
		manifest.kind !== "manifest"
	) {
		const found = String(manifest.version ?? "missing");
		rmSync(path, { recursive: true, force: true });
		throw new StateVersionError(found);
	}
}

export class Store {
	readonly path: string;
	private readonly agents = new Map<string, AgentRecord>();
	private readonly idles = new Map<string, IdleFile>();
	private global = emptyGlobal();
	private transactionDepth = 0;
	private dirty = false;

	constructor(path: string) {
		this.path = path;
		prepareStateDirectory(path);
		try {
			this.load();
		} catch (error) {
			rmSync(path, { recursive: true, force: true });
			if (error instanceof StateVersionError) throw error;
			throw new StateVersionError("invalid");
		}
	}
	close(): void {
		if (this.dirty) this.flush();
	}
	transaction<T>(fn: () => T): T {
		const snapshot =
			this.transactionDepth === 0
				? structuredClone({
						global: this.global,
						agents: [...this.agents],
						idles: [...this.idles],
					})
				: undefined;
		this.transactionDepth++;
		try {
			const value = fn();
			this.transactionDepth--;
			if (this.transactionDepth === 0 && this.dirty) this.flush();
			return value;
		} catch (error) {
			this.transactionDepth--;
			if (snapshot) {
				this.global = snapshot.global;
				this.agents.clear();
				for (const [key, value] of snapshot.agents) this.agents.set(key, value);
				this.idles.clear();
				for (const [key, value] of snapshot.idles) this.idles.set(key, value);
				this.dirty = false;
			}
			throw error;
		}
	}
	private loadEnvelope<T>(path: string, kind: string): T {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<
			Envelope<T>
		>;
		if (
			value.format !== STATE_FORMAT ||
			value.version !== STATE_VERSION ||
			value.kind !== kind ||
			value.data === undefined
		)
			throw new StateVersionError(String(value.version ?? "missing"));
		return value.data;
	}
	private load(): void {
		const globalPath = join(this.path, "global.json");
		if (existsSync(globalPath))
			this.global = this.loadEnvelope(globalPath, "global");
		for (const [directory, kind, target] of [
			["agents", "agent", this.agents],
			["idles", "idle", this.idles],
		] as const) {
			const path = join(this.path, directory);
			if (!existsSync(path)) continue;
			for (const file of readdirSync(path)) {
				if (!file.endsWith(".json")) continue;
				const data = this.loadEnvelope<AgentRecord | IdleFile>(
					join(path, file),
					kind,
				);
				const key = basename(file, ".json");
				(target as Map<string, AgentRecord | IdleFile>).set(key, data);
			}
		}
	}
	private changed(): void {
		this.dirty = true;
		if (this.transactionDepth === 0) this.flush();
	}
	private flush(): void {
		writeJson(join(this.path, "global.json"), envelope("global", this.global));
		const agentDir = join(this.path, "agents");
		const idleDir = join(this.path, "idles");
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		mkdirSync(idleDir, { recursive: true, mode: 0o700 });
		for (const [id, value] of this.agents)
			writeJson(join(agentDir, `${id}.json`), envelope("agent", value));
		for (const [id, value] of this.idles)
			writeJson(join(idleDir, `${id}.json`), envelope("idle", value));
		this.dirty = false;
	}

	insertAgent(agent: AgentRecord, prompt: string): void {
		if (this.agents.has(agent.agentId))
			throw new Error(`Agent ${agent.agentId} already exists`);
		this.agents.set(agent.agentId, structuredClone(agent));
		this.global.runs.push({
			runId: agent.currentRunId,
			agentId: agent.agentId,
			generation: agent.generation,
			prompt,
			state: agent.state,
			createdAt: agent.createdAt,
		});
		this.changed();
	}
	getAgent(agentId: string): AgentRecord | undefined {
		const value = this.agents.get(agentId);
		return value ? structuredClone(value) : undefined;
	}
	listAgents(
		parentSessionId: string,
		state?: AgentState,
		offset = 0,
		limit = 50,
	): AgentRecord[] {
		return [...this.agents.values()]
			.filter(
				(agent) =>
					agent.parentSessionId === parentSessionId &&
					(!state || agent.state === state),
			)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(offset, offset + limit)
			.map((agent) => structuredClone(agent));
	}
	listSchedulable(): AgentRecord[] {
		return this.filteredAgents(
			(agent) =>
				(agent.state === "queued" || agent.state === "recovering") &&
				agent.desiredState === "running",
		);
	}
	listActive(): AgentRecord[] {
		return this.filteredAgents((agent) =>
			["running", "pausing", "stopping"].includes(agent.state),
		);
	}
	listBlocked(): AgentRecord[] {
		return this.filteredAgents(
			(agent) => agent.state === "blocked" && agent.desiredState === "running",
		).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	}
	private filteredAgents(
		predicate: (agent: AgentRecord) => boolean,
	): AgentRecord[] {
		return [...this.agents.values()]
			.filter(predicate)
			.map((agent) => structuredClone(agent));
	}
	countOutstanding(parentSessionId?: string): number {
		return [...this.agents.values()].filter(
			(agent) =>
				(!parentSessionId || agent.parentSessionId === parentSessionId) &&
				!["completed", "failed", "stopped"].includes(agent.state),
		).length;
	}
	countAgents(): number {
		return this.agents.size;
	}
	findOutstandingByParentScope(
		parentSessionId: string,
		scopeKey: string,
	): AgentRecord | undefined {
		return this.filteredAgents(
			(agent) =>
				agent.parentSessionId === parentSessionId &&
				agent.config.scopeKey === scopeKey &&
				!["completed", "failed", "stopped"].includes(agent.state),
		).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
	}
	updateAgent(agentId: string, values: AgentUpdate): void {
		const agent = this.agents.get(agentId);
		if (!agent) return;
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined)
				delete (agent as unknown as Record<string, unknown>)[key];
			else
				(agent as unknown as Record<string, unknown>)[key] =
					structuredClone(value);
		}
		this.changed();
	}
	createRun(
		runId: string,
		agentId: string,
		generation: number,
		prompt: string,
		at: string,
		state = "queued",
	): void {
		this.global.runs.push({
			runId,
			agentId,
			generation,
			prompt,
			state,
			createdAt: at,
		});
		this.changed();
	}
	updateRun(
		runId: string,
		state: string,
		at: string,
		error?: NormalizedError,
		usage?: unknown,
	): void {
		const run = this.global.runs.find((value) => value.runId === runId);
		if (!run) return;
		run.state = state;
		if (state === "running") run.startedAt ??= at;
		if (["completed", "failed", "blocked", "stopped"].includes(state))
			run.finishedAt = at;
		if (error) run.error = structuredClone(error);
		if (usage !== undefined) run.usage = structuredClone(usage as UsageTotals);
		this.changed();
	}
	getRun(runId: string): RunRecord | undefined {
		const run = this.global.runs.find((value) => value.runId === runId);
		return run ? structuredClone(run) : undefined;
	}
	getRunPrompt(runId: string): string | undefined {
		return this.global.runs.find((value) => value.runId === runId)?.prompt;
	}
	countRuns(agentId: string): number {
		return this.global.runs.filter((run) => run.agentId === agentId).length;
	}
	updateRunUsage(runId: string, usage: UsageTotals): void {
		const run = this.global.runs.find((value) => value.runId === runId);
		if (!run) return;
		run.usage = structuredClone(usage);
		this.changed();
	}
	getRunUsage(runId: string): UsageTotals | null {
		const usage = this.global.runs.find(
			(value) => value.runId === runId,
		)?.usage;
		return usage ? structuredClone(usage) : null;
	}
	usageReport(
		agentId: string,
		currentRunId: string,
		limits: RuntimeLimits,
	): UsageReport {
		const runs = this.global.runs.filter((run) => run.agentId === agentId);
		const lifetime = emptyUsage();
		for (const run of runs) if (run.usage) addUsage(lifetime, run.usage);
		return {
			currentRun: this.getRunUsage(currentRunId),
			lifetime: { ...lifetime, runs: runs.length },
			limits,
			subscriptionQuota: "unknown",
		};
	}
	setRunGeneration(runId: string, generation: number): void {
		const run = this.global.runs.find((value) => value.runId === runId);
		if (run) {
			run.generation = generation;
			this.changed();
		}
	}
	getRunGeneration(runId: string): number | undefined {
		return this.global.runs.find((value) => value.runId === runId)?.generation;
	}
	addEvent(
		agentId: string,
		runId: string | undefined,
		type: string,
		data: unknown,
		at: string,
	): number {
		const id = this.global.nextEventId++;
		this.global.events.push({
			id,
			agentId,
			...(runId ? { runId } : {}),
			type,
			data: structuredClone(data),
			createdAt: at,
		});
		this.changed();
		return id;
	}
	countRunEvents(runId: string, type: string): number {
		return this.global.events.filter(
			(event) => event.runId === runId && event.type === type,
		).length;
	}
	events(agentIds: string[], afterId: number, limit = 100): EventRecord[] {
		const wanted = new Set(agentIds);
		return this.global.events
			.filter((event) => wanted.has(event.agentId) && event.id > afterId)
			.sort((a, b) => a.id - b.id)
			.slice(0, limit)
			.map((event) => structuredClone(event));
	}
	maxEventId(): number {
		return this.global.nextEventId - 1;
	}
	getIdempotency(
		scope: string,
		key: string,
	): { payloadHash: string; response: unknown } | undefined {
		const value = this.global.idempotency.find(
			(record) => record.scope === scope && record.key === key,
		);
		return value
			? {
					payloadHash: value.payloadHash,
					response: structuredClone(value.response),
				}
			: undefined;
	}
	setIdempotency(
		scope: string,
		key: string,
		payloadHash: string,
		response: unknown,
		at: string,
	): void {
		if (
			this.global.idempotency.some(
				(record) => record.scope === scope && record.key === key,
			)
		)
			throw new Error(`Idempotency key already exists: ${scope}/${key}`);
		this.global.idempotency.push({
			scope,
			key,
			payloadHash,
			response: structuredClone(response),
			createdAt: at,
		});
		this.changed();
	}
	addMessage(message: MessageRecord): void {
		if (
			this.global.messages.some(
				(value) => value.messageId === message.messageId,
			)
		)
			throw new Error(`Message ${message.messageId} already exists`);
		this.global.messages.push(structuredClone(message));
		this.changed();
	}
	nextMessageSequence(agentId: string): number {
		return (
			Math.max(
				0,
				...this.global.messages
					.filter((message) => message.agentId === agentId)
					.map((message) => message.sequence),
			) + 1
		);
	}
	pendingMessages(agentId: string): MessageRecord[] {
		return this.global.messages
			.filter(
				(message) => message.agentId === agentId && message.state !== "applied",
			)
			.sort((a, b) => a.sequence - b.sequence)
			.map((message) => structuredClone(message));
	}
	markMessage(messageId: string, state: MessageRecord["state"]): void {
		const message = this.global.messages.find(
			(value) => value.messageId === messageId,
		);
		if (message) {
			message.state = state;
			this.changed();
		}
	}
	toolStart(
		agentId: string,
		runId: string,
		generation: number,
		toolCallId: string,
		toolName: string,
		argsHash: string,
		at: string,
	): void {
		if (
			this.global.toolOperations.some(
				(value) =>
					value.agentId === agentId &&
					value.runId === runId &&
					value.toolCallId === toolCallId,
			)
		)
			return;
		this.global.toolOperations.push({
			agentId,
			runId,
			generation,
			toolCallId,
			toolName,
			argsHash,
			state: "started",
			startedAt: at,
		});
		this.changed();
	}
	toolFinish(
		agentId: string,
		runId: string,
		toolCallId: string,
		at: string,
	): void {
		const operation = this.global.toolOperations.find(
			(value) =>
				value.agentId === agentId &&
				value.runId === runId &&
				value.toolCallId === toolCallId,
		);
		if (operation) {
			operation.state = "finished";
			operation.finishedAt = at;
			this.changed();
		}
	}
	uncertainTools(
		agentId: string,
		runId: string,
	): Array<{ toolCallId: string; toolName: string }> {
		return this.global.toolOperations
			.filter(
				(value) =>
					value.agentId === agentId &&
					value.runId === runId &&
					value.state === "started",
			)
			.map(({ toolCallId, toolName }) => ({ toolCallId, toolName }));
	}
	reconcileTool(
		agentId: string,
		runId: string,
		toolCallId: string,
		resolution: "retry" | "skip",
		at: string,
	): void {
		const operation = this.global.toolOperations.find(
			(value) =>
				value.agentId === agentId &&
				value.runId === runId &&
				value.toolCallId === toolCallId &&
				value.state === "started",
		);
		if (operation) {
			operation.state = `reconciled_${resolution}`;
			operation.finishedAt = at;
			this.changed();
		}
	}
	putCooldown(block: CooldownRecord): void {
		const index = this.global.cooldowns.findIndex(
			(value) => value.scopeKey === block.scopeKey,
		);
		if (index >= 0) this.global.cooldowns[index] = structuredClone(block);
		else this.global.cooldowns.push(structuredClone(block));
		this.changed();
	}
	getCooldown(scopeKey: string): CooldownRecord | undefined {
		const value = this.global.cooldowns.find(
			(block) => block.scopeKey === scopeKey,
		);
		return value ? structuredClone(value) : undefined;
	}
	claimCooldownProbe(
		scopeKey: string,
		agentId: string,
		at: string,
	): string | undefined {
		const block = this.global.cooldowns.find(
			(value) => value.scopeKey === scopeKey,
		);
		if (!block) return undefined;
		if (!block.probeAgentId || block.probeAgentId === agentId) {
			block.probeAgentId = agentId;
			block.updatedAt = at;
			this.changed();
			return agentId;
		}
		return block.probeAgentId;
	}
	releaseCooldownProbe(scopeKey: string, agentId: string, at: string): void {
		const block = this.global.cooldowns.find(
			(value) => value.scopeKey === scopeKey && value.probeAgentId === agentId,
		);
		if (block) {
			delete block.probeAgentId;
			block.updatedAt = at;
			this.changed();
		}
	}
	clearCooldown(scopeKey: string): void {
		this.global.cooldowns = this.global.cooldowns.filter(
			(value) => value.scopeKey !== scopeKey,
		);
		this.changed();
	}
	enqueueOutbox(
		eventId: number,
		parentSessionId: string,
		agentId: string,
		payload: unknown,
		at: string,
	): void {
		if (this.global.outbox.some((value) => value.eventId === eventId)) return;
		this.global.outbox.push({
			eventId,
			parentSessionId,
			agentId,
			payload: structuredClone(payload),
			state: "pending",
			attempts: 0,
			createdAt: at,
		});
		this.changed();
	}
	pendingOutbox(
		parentSessionId: string,
		limit = 20,
	): Array<{ eventId: number; agentId: string; payload: unknown }> {
		return this.global.outbox
			.filter(
				(value) =>
					value.parentSessionId === parentSessionId &&
					value.state === "pending",
			)
			.sort((a, b) => a.eventId - b.eventId)
			.slice(0, limit)
			.map(({ eventId, agentId, payload }) => ({
				eventId,
				agentId,
				payload: structuredClone(payload),
			}));
	}
	outboxState(eventId: number): OutboxRecord["state"] | undefined {
		return this.global.outbox.find((value) => value.eventId === eventId)?.state;
	}
	ackOutbox(parentSessionId: string, eventIds: number[], at: string): void {
		const wanted = new Set(eventIds);
		for (const item of this.global.outbox)
			if (
				item.parentSessionId === parentSessionId &&
				item.state === "pending" &&
				wanted.has(item.eventId)
			) {
				item.state = "delivered";
				item.deliveredAt = at;
			}
		const parent = this.global.parents.find(
			(value) => value.parentSessionId === parentSessionId,
		);
		if (parent && eventIds.length)
			parent.lastAckEventId = Math.max(parent.lastAckEventId, ...eventIds);
		this.changed();
	}
	supersedeAgentOutbox(
		parentSessionId: string,
		agentIds: string[],
		at: string,
	): void {
		const wanted = new Set(agentIds);
		for (const item of this.global.outbox)
			if (
				item.parentSessionId === parentSessionId &&
				item.state === "pending" &&
				wanted.has(item.agentId) &&
				(item.payload as { kind?: string } | null)?.kind !== "idle_resolved"
			) {
				item.state = "superseded";
				item.deliveredAt = at;
			}
		this.changed();
	}
	attachParent(
		parentSessionId: string,
		branchAnchor: string | undefined,
		at: string,
	): void {
		let parent = this.global.parents.find(
			(value) => value.parentSessionId === parentSessionId,
		);
		if (!parent) {
			parent = {
				parentSessionId,
				attachedAt: at,
				lastAckEventId: 0,
				attached: true,
			};
			this.global.parents.push(parent);
		}
		if (branchAnchor === undefined) delete parent.branchAnchor;
		else parent.branchAnchor = branchAnchor;
		parent.attachedAt = at;
		parent.attached = true;
		delete parent.detachedAt;
		delete parent.detachReason;
		this.changed();
	}
	detachParent(parentSessionId: string, reason: string, at: string): void {
		const parent = this.global.parents.find(
			(value) => value.parentSessionId === parentSessionId,
		);
		if (parent) {
			parent.attached = false;
			parent.detachedAt = at;
			parent.detachReason = reason;
			this.changed();
		}
	}
	isParentAttached(parentSessionId: string): boolean {
		return (
			this.global.parents.find(
				(value) => value.parentSessionId === parentSessionId,
			)?.attached ?? false
		);
	}
	insertIdle(barrier: IdleBarrierRecord, agentIds: string[]): void {
		if (this.idles.has(barrier.idleId))
			throw new Error(`Idle ${barrier.idleId} already exists`);
		this.idles.set(barrier.idleId, {
			barrier: structuredClone(barrier),
			agentIds: [...agentIds],
		});
		this.changed();
	}
	getIdle(idleId: string): IdleBarrierRecord | undefined {
		const value = this.idles.get(idleId)?.barrier;
		return value ? structuredClone(value) : undefined;
	}
	pendingIdles(agentId?: string): IdleBarrierRecord[] {
		return [...this.idles.values()]
			.filter(
				(value) =>
					value.barrier.state === "pending" &&
					(!agentId || value.agentIds.includes(agentId)),
			)
			.sort((a, b) => a.barrier.createdAt.localeCompare(b.barrier.createdAt))
			.map((value) => structuredClone(value.barrier));
	}
	listIdles(parentSessionId: string, state?: IdleState): IdleBarrierRecord[] {
		return [...this.idles.values()]
			.map((value) => value.barrier)
			.filter(
				(barrier) =>
					barrier.parentSessionId === parentSessionId &&
					(!state || barrier.state === state),
			)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, 50)
			.map((barrier) => structuredClone(barrier));
	}
	listIdlesByDisconnectPolicy(
		policy: "continue_headless",
	): IdleBarrierRecord[] {
		return [...this.idles.values()]
			.map((value) => value.barrier)
			.filter(
				(barrier) =>
					barrier.state === "resolved" &&
					barrier.disconnectPolicy === policy &&
					["none", "running"].includes(barrier.headlessState),
			)
			.sort((a, b) => (a.resolvedAt ?? "").localeCompare(b.resolvedAt ?? ""))
			.map((barrier) => structuredClone(barrier));
	}
	idleAgents(idleId: string): AgentRecord[] {
		return (this.idles.get(idleId)?.agentIds ?? []).flatMap((id) => {
			const value = this.agents.get(id);
			return value ? [structuredClone(value)] : [];
		});
	}
	resolveIdle(idleId: string, resolution: IdleResolution, at: string): void {
		const barrier = this.idles.get(idleId)?.barrier;
		if (barrier?.state === "pending") {
			barrier.state = "resolved";
			barrier.resolution = resolution;
			barrier.resolvedAt = at;
			this.changed();
		}
	}
	claimHeadless(idleId: string, runId: string): boolean {
		const barrier = this.idles.get(idleId)?.barrier;
		if (barrier?.state !== "resolved" || barrier.headlessState !== "none")
			return false;
		barrier.headlessState = "running";
		barrier.headlessRunId = runId;
		delete barrier.headlessPid;
		delete barrier.headlessError;
		this.changed();
		return true;
	}
	setHeadlessPid(idleId: string, runId: string, pid: number | undefined): void {
		const barrier = this.idles.get(idleId)?.barrier;
		if (
			barrier?.headlessState === "running" &&
			barrier.headlessRunId === runId
		) {
			if (pid === undefined) delete barrier.headlessPid;
			else barrier.headlessPid = pid;
			this.changed();
		}
	}
	resetHeadless(idleId: string, runId: string): void {
		const barrier = this.idles.get(idleId)?.barrier;
		if (
			barrier?.headlessState === "running" &&
			barrier.headlessRunId === runId
		) {
			barrier.headlessState = "none";
			delete barrier.headlessRunId;
			delete barrier.headlessPid;
			this.changed();
		}
	}
	finishHeadless(
		idleId: string,
		runId: string,
		state: "completed" | "failed",
		error?: string,
	): void {
		const barrier = this.idles.get(idleId)?.barrier;
		if (
			barrier?.headlessState === "running" &&
			barrier.headlessRunId === runId
		) {
			barrier.headlessState = state;
			delete barrier.headlessPid;
			if (error === undefined) delete barrier.headlessError;
			else barrier.headlessError = error;
			this.changed();
		}
	}
	cancelIdle(idleId: string, at: string): void {
		const barrier = this.idles.get(idleId)?.barrier;
		if (barrier?.state === "pending") {
			barrier.state = "cancelled";
			barrier.resolvedAt = at;
			this.changed();
		}
	}
	setIdleActivity(
		idleId: string,
		policy: IdleActivityPolicy,
		wakeMode: "auto" | "notify_only",
	): void {
		const barrier = this.idles.get(idleId)?.barrier;
		if (barrier?.state === "pending") {
			barrier.activityPolicy = policy;
			barrier.wakeMode = wakeMode;
			this.changed();
		}
	}
	updateIdleAgents(idleId: string, agentIds: string[]): void {
		const idle = this.idles.get(idleId);
		if (idle) {
			idle.agentIds = [...agentIds];
			this.changed();
		}
	}
}
