export const AGENT_STATES = [
	"queued",
	"running",
	"pausing",
	"paused",
	"blocked",
	"recovering",
	"completed",
	"failed",
	"stopping",
	"stopped",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];
export type DesiredState = "running" | "paused" | "stopped";
export type DeliveryKind = "steer" | "followUp";
export type RecoveryPolicy = "manual" | "when_available";
export type ReasoningLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";
export type IdleState = "pending" | "resolved" | "cancelled";
export type IdleUntil =
	| "all_settled"
	| "any_settled"
	| "all_succeeded"
	| "first_failure"
	| "quorum";
export type IdleResolution =
	| "all_settled"
	| "any_settled"
	| "all_succeeded"
	| "first_failure"
	| "quorum"
	| "attention_required";
export type IdleActivityPolicy = "keep" | "cancel" | "notify_only";
export type IdleDisconnectPolicy = "defer" | "continue_headless";

export interface ModelRef {
	provider: string;
	id: string;
}
export interface ScopedModelRef {
	model: ModelRef;
	thinkingLevel?: ReasoningLevel;
}
export const DEFAULT_RUNTIME_SECONDS = 60 * 60;
export interface Limits {
	runtimeSeconds?: number;
}
export interface RuntimeLimits {
	runtimeSeconds: number;
}
export function normalizeLimits(value: unknown): RuntimeLimits {
	const limits =
		value && typeof value === "object"
			? (value as { runtimeSeconds?: unknown })
			: {};
	const seconds = Number(limits.runtimeSeconds);
	return {
		runtimeSeconds:
			Number.isFinite(seconds) && seconds > 0
				? Math.ceil(seconds)
				: DEFAULT_RUNTIME_SECONDS,
	};
}
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number | null;
}
export interface UsageReport {
	currentRun: UsageTotals | null;
	lifetime: UsageTotals & { runs: number };
	limits: RuntimeLimits;
	subscriptionQuota: "unknown";
}
export interface AdmissionStatus {
	status: "no_known_block" | "cooling_down" | "manual_retry_required";
	message: string;
	kind?: AvailabilityBlock["kind"];
	retryAt?: string;
	notBefore?: string;
	attempts?: number;
	provenance?: AvailabilityBlock["provenance"];
	automaticRetryAllowed?: boolean;
}
export interface WorkspaceSpec {
	mode: "shared" | "worktree";
	path?: string;
	sourceRoot?: string;
	baseRevision?: string;
}
export interface EffectiveConfig {
	model: ModelRef;
	reasoning: ReasoningLevel;
	tools: string[];
	extensionPaths?: string[];
	cwd: string;
	workspace: WorkspaceSpec;
	instructions: string;
	context?: string;
	profile?: ProfileSnapshot;
	recovery: RecoveryPolicy;
	recoveryDeadline: string;
	limits: RuntimeLimits;
	scopeKey: string;
}
export interface ProfileSnapshot {
	qualifiedName: string;
	name: string;
	description: string;
	source: "user" | "project";
	filePath: string;
	hash: string;
	instructions: string;
	model?: string;
	reasoning?: ReasoningLevel;
	tools?: string[];
}
export interface SpawnInput {
	action: "spawn";
	prompt: string;
	model: ModelRef;
	name?: string;
	profile?: string;
	instructions?: string;
	reasoning?: ReasoningLevel;
	tools?: string[];
	cwd?: string;
	workspace?:
		| "shared"
		| "worktree"
		| { mode: "shared" | "worktree"; path?: string };
	context?: string;
	recovery?: RecoveryPolicy;
	limits?: Limits;
	blockedPolicy?: "reject" | "enqueue";
	requestId?: string;
}
export type AgentAction =
	| SpawnInput
	| { action: "catalog"; provider?: string; cursor?: string }
	| { action: "list"; state?: AgentState; cursor?: string }
	| {
			action: "inspect";
			agentId: string;
			afterEventId?: number;
	  }
	| { action: "inspect_many"; agentIds: string[] }
	| {
			action: "wait";
			agentIds: string[];
			afterEventId?: number;
			timeoutMs?: number;
	  }
	| {
			action: "idle";
			agentIds: string[];
			until?: IdleUntil;
			quorum?: number;
			activityPolicy?: IdleActivityPolicy;
			disconnectPolicy?: IdleDisconnectPolicy;
			requestId?: string;
	  }
	| { action: "idle_list"; state?: IdleState }
	| { action: "idle_inspect"; idleId: string }
	| {
			action: "idle_update";
			idleId: string;
			addAgentIds?: string[];
			removeAgentIds?: string[];
			requestId?: string;
	  }
	| { action: "idle_cancel"; idleId: string; requestId?: string }
	| {
			action: "message";
			agentId: string;
			text: string;
			delivery: DeliveryKind;
			requestId?: string;
	  }
	| { action: "pause"; agentId: string; mode?: "graceful" | "interrupt" }
	| {
			action: "resume";
			agentId: string;
			prompt?: string;
			model?: ModelRef;
			reasoning?: ReasoningLevel;
			requestId?: string;
	  }
	| { action: "stop"; agentId: string; reason?: string };

export interface ParentIdentity {
	sessionId: string;
	sessionFile?: string;
	branchAnchor?: string;
}
export interface IdleBarrierRecord {
	idleId: string;
	parentSessionId: string;
	branchAnchor?: string;
	state: IdleState;
	until: IdleUntil;
	quorum?: number;
	activityPolicy: IdleActivityPolicy;
	wakeMode: "auto" | "notify_only";
	disconnectPolicy: IdleDisconnectPolicy;
	parentSessionFile?: string;
	parentModel?: ModelRef;
	parentReasoning?: ReasoningLevel;
	parentCwd?: string;
	headlessState: "none" | "running" | "completed" | "failed";
	headlessRunId?: string;
	headlessPid?: number;
	headlessError?: string;
	resolution?: IdleResolution;
	createdAt: string;
	resolvedAt?: string;
}
export interface ToolRequest {
	requestId: string;
	toolCallId: string;
	parent: ParentIdentity;
	parentModel?: ModelRef;
	parentReasoning?: ReasoningLevel;
	parentScopedModels?: ScopedModelRef[];
	cwd: string;
	trustedProject: boolean;
	hostTools: string[];
	hostToolSources?: Array<{ name: string; path: string }>;
	action: AgentAction;
}
export interface AgentRecord {
	agentId: string;
	parentSessionId: string;
	parentSessionFile?: string;
	branchAnchor?: string;
	name?: string;
	task: string;
	config: EffectiveConfig;
	state: AgentState;
	desiredState: DesiredState;
	reason?: string;
	generation: number;
	currentRunId: string;
	sessionId?: string;
	sessionFile?: string;
	workerPid?: number;
	leaseUntil?: string;
	checkpoint?: string;
	resultPath?: string;
	resultSummary?: string;
	error?: NormalizedError;
	createdAt: string;
	updatedAt: string;
}
export interface NormalizedError {
	code: string;
	message: string;
	retryable: boolean;
	retryAt?: string;
}
export interface AvailabilityBlock {
	kind:
		| "short_rate_limit"
		| "usage_exhausted"
		| "auth_required"
		| "access_denied"
		| "transient"
		| "unknown";
	scopeKey: string;
	retryAt?: string;
	provenance:
		| "retry_after"
		| "provider_reset"
		| "configured_estimate"
		| "unknown";
	automaticRetryAllowed: boolean;
}
export interface WorkerConfig {
	protocolVersion: 1;
	socketPath: string;
	tokenPath: string;
	stateDir: string;
	agentDir: string;
	agentId: string;
	runId: string;
	generation: number;
	prompt: string;
	continuation: boolean;
	config: EffectiveConfig;
	sessionFile?: string;
}
export interface HeadlessConfig {
	protocolVersion: 1;
	socketPath: string;
	tokenPath: string;
	stateDir: string;
	agentDir: string;
	idleId: string;
	headlessRunId: string;
	parentSessionId: string;
	sessionFile: string;
	cwd: string;
	model: ModelRef;
	reasoning: ReasoningLevel;
	prompt: string;
}
export interface EventRecord {
	id: number;
	agentId: string;
	runId?: string;
	type: string;
	data: unknown;
	createdAt: string;
}
export interface Clock {
	now(): Date;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}
export const systemClock: Clock = {
	now: () => new Date(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
