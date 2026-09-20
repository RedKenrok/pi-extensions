import { existsSync } from "node:fs";
import type { Store } from "./store.ts";
import type { AgentRecord } from "./types.ts";

const repeatableTools = new Set(["read", "grep", "find", "ls"]);

export interface Reconciliation {
	safe: boolean;
	reason: string;
	uncertain: Array<{ toolCallId: string; toolName: string }>;
}

export function reconcileInterrupted(
	store: Store,
	agent: AgentRecord,
): Reconciliation {
	if (agent.sessionFile && !existsSync(agent.sessionFile))
		return { safe: false, reason: "missing_transcript", uncertain: [] };
	if (!existsSync(agent.config.cwd))
		return { safe: false, reason: "missing_workspace", uncertain: [] };
	const uncertain = store.uncertainTools(agent.agentId, agent.currentRunId);
	const unsafe = uncertain.filter(
		(operation) => !repeatableTools.has(operation.toolName),
	);
	if (unsafe.length)
		return { safe: false, reason: "uncertain_side_effects", uncertain };
	return {
		safe: true,
		reason: uncertain.length ? "repeatable_reads_only" : "clean_checkpoint",
		uncertain,
	};
}

export function continuationPrompt(
	agent: AgentRecord,
	interruptionReason: string,
): string {
	return [
		"Continue the same assignment from the saved session.",
		`Original objective: ${agent.task}`,
		`Interruption: ${interruptionReason}.`,
		"Inspect the existing transcript and workspace before acting. Do not repeat completed side effects.",
		"If any prior external or write operation has an uncertain outcome, stop and explain what evidence is needed.",
	].join("\n");
}
