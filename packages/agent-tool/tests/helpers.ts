import type {
	AgentRecord,
	EffectiveConfig,
	ToolRequest,
} from "../src/types.ts";

export const config: EffectiveConfig = {
	model: { provider: "faux", id: "test" },
	reasoning: "off",
	tools: ["read"],
	cwd: process.cwd(),
	workspace: { mode: "shared", path: process.cwd() },
	instructions: "",
	recovery: "when_available",
	recoveryDeadline: "2099-01-01T00:00:00.000Z",
	limits: { runtimeSeconds: 3600 },
	scopeKey: "scope-a",
};
export function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		agentId: "ag_test",
		parentSessionId: "parent-a",
		task: "test",
		config,
		state: "queued",
		desiredState: "running",
		generation: 1,
		currentRunId: "run_test",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}
export function request(
	action: ToolRequest["action"],
	overrides: Partial<ToolRequest> = {},
): ToolRequest {
	return {
		requestId: "req",
		toolCallId: "tool-call",
		parent: { sessionId: "parent-a", branchAnchor: "leaf-a" },
		parentModel: config.model,
		parentReasoning: "off",
		cwd: process.cwd(),
		trustedProject: true,
		hostTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "agent"],
		action,
		...overrides,
	};
}
