import { createDiagnostics, diagnosticsEnabled } from "shared/diagnostics";

export const PACKAGE_NAME = "codex-compaction";

/**
 * Stable, content-free codes describing why remote compaction was not used.
 * They are safe to print and to persist because they never carry tokens,
 * account identifiers, or conversation text.
 */
export type FallbackReason =
	| "custom_instructions"
	| "no_model"
	| "untrusted_model"
	| "auth_unavailable"
	| "aborted"
	| "invalid_checkpoint"
	| "summary_without_checkpoint"
	| "checkpoint_incompatible"
	| "tail_incompatible"
	| "nothing_to_discard"
	| "native_failed"
	| "remote_failed"
	| "remote_grace_elapsed";

export type DebugSink = (reason: FallbackReason) => void;

export function debugEnabled(value: string | undefined): boolean {
	return diagnosticsEnabled(PACKAGE_NAME, { PI_EXT_DEBUG: value });
}

export function createDebugSink(
	env: NodeJS.ProcessEnv = process.env,
	write?: (line: string) => void,
): DebugSink {
	return createDiagnostics(PACKAGE_NAME, { env, ...(write ? { write } : {}) });
}
