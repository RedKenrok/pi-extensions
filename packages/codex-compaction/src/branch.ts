import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { FallbackReason } from "./debug.ts";
import {
	CODEX_RESPONSES_URL,
	isRecord,
	isTrustedModel,
	type JsonObject,
	parseCheckpoint,
	type RemoteCheckpoint,
} from "./remote.ts";

export type AgentMessage =
	SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

export interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export interface LatestCompaction {
	entry: JsonObject;
	index: number;
}

export type PriorCheckpoint =
	| { state: "none" }
	| { state: "invalid" }
	| { state: "valid"; checkpoint: RemoteCheckpoint };

export function latestCompaction(
	branch: readonly unknown[],
): LatestCompaction | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (isRecord(entry) && entry.type === "compaction") return { entry, index };
	}
	return undefined;
}

export function checkpointFromEntry(
	latest: LatestCompaction | undefined,
): PriorCheckpoint {
	if (!latest) return { state: "none" };
	const details = latest.entry.details;
	if (!isRecord(details) || !("remoteCompaction" in details))
		return { state: "invalid" };
	const checkpoint = parseCheckpoint(details.remoteCompaction);
	return checkpoint ? { state: "valid", checkpoint } : { state: "invalid" };
}

export function checkpointCompatible(
	checkpoint: RemoteCheckpoint,
	model: Model<Api>,
	fingerprint: string,
): boolean {
	return (
		checkpoint.model === model.id &&
		checkpoint.accountFingerprint === fingerprint &&
		checkpoint.endpoint === CODEX_RESPONSES_URL &&
		checkpoint.api === model.api
	);
}

// Pi skips cumulative file details from extension-created compactions, so the
// extension restores them from its own validated entry before delegating.
export function addCumulativeFiles(fileOps: FileOps, entry: JsonObject): void {
	const details = entry.details;
	if (!isRecord(details)) return;
	if (Array.isArray(details.readFiles)) {
		for (const path of details.readFiles)
			if (typeof path === "string") fileOps.read.add(path);
	}
	if (Array.isArray(details.modifiedFiles)) {
		for (const path of details.modifiedFiles)
			if (typeof path === "string") fileOps.edited.add(path);
	}
}

/**
 * The opaque checkpoint only stays meaningful while every assistant message
 * that Pi keeps beside it came from the same provider, model, and API.
 */
export function tailIsCompatible(
	branch: readonly unknown[],
	latest: LatestCompaction,
	model: Model<Api>,
): boolean {
	const id = latest.entry.id;
	const firstKeptEntryId = latest.entry.firstKeptEntryId;
	if (typeof id !== "string" || typeof firstKeptEntryId !== "string")
		return false;
	let idMatches = 0;
	let firstKeptMatches = 0;
	let firstKeptIndex = -1;
	for (let index = 0; index < branch.length; index += 1) {
		const entry = branch[index];
		if (!isRecord(entry)) continue;
		if (entry.id === id) idMatches += 1;
		if (entry.id === firstKeptEntryId) {
			firstKeptMatches += 1;
			if (firstKeptIndex < 0) firstKeptIndex = index;
		}
	}
	// Pi uses the compaction's own ID for retain-none compactions, so equality
	// is valid; duplicate boundary IDs are not.
	if (
		idMatches !== 1 ||
		firstKeptMatches !== 1 ||
		firstKeptIndex > latest.index
	)
		return false;
	for (let index = firstKeptIndex; index < branch.length; index += 1) {
		if (index === latest.index) continue;
		const entry = branch[index];
		if (
			!isRecord(entry) ||
			entry.type !== "message" ||
			!isRecord(entry.message) ||
			entry.message.role !== "assistant"
		)
			continue;
		if (
			entry.message.provider !== model.provider ||
			entry.message.model !== model.id ||
			entry.message.api !== model.api
		)
			return false;
	}
	return true;
}

export type RemotePlan =
	| { ok: false; reason: FallbackReason }
	| {
			ok: true;
			model: Model<Api>;
			prior: RemoteCheckpoint | undefined;
			discarded: AgentMessage[];
	  };

/**
 * Decides, without touching credentials or the network, whether a compaction
 * may use the remote endpoint. Each refusal carries the reason code that is
 * reported through diagnostics.
 */
export function planRemoteCompaction(
	event: Pick<
		SessionBeforeCompactEvent,
		"branchEntries" | "customInstructions" | "preparation"
	>,
	model: Model<Api> | undefined,
	latest: LatestCompaction | undefined,
	prior: PriorCheckpoint,
): RemotePlan {
	// The remote protocol cannot guarantee custom instructions are honored.
	if (event.customInstructions !== undefined)
		return { ok: false, reason: "custom_instructions" };
	if (!model) return { ok: false, reason: "no_model" };
	if (!isTrustedModel(model)) return { ok: false, reason: "untrusted_model" };
	if (prior.state === "invalid")
		return { ok: false, reason: "invalid_checkpoint" };
	// A readable summary without a usable opaque checkpoint means remote
	// compaction would silently forget already-discarded history.
	if (event.preparation.previousSummary && prior.state !== "valid")
		return { ok: false, reason: "summary_without_checkpoint" };
	if (
		prior.state === "valid" &&
		latest &&
		!tailIsCompatible(event.branchEntries, latest, model)
	)
		return { ok: false, reason: "tail_incompatible" };
	const discarded: AgentMessage[] = [
		...event.preparation.messagesToSummarize,
		...(event.preparation.isSplitTurn
			? event.preparation.turnPrefixMessages
			: []),
	];
	if (discarded.length === 0)
		return { ok: false, reason: "nothing_to_discard" };
	return {
		ok: true,
		model,
		prior: prior.state === "valid" ? prior.checkpoint : undefined,
		discarded,
	};
}
