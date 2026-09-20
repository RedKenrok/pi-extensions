import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import {
	compact,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	accountFingerprint,
	accountIdFromToken,
	CODEX_BASE_URL,
	CODEX_RESPONSES_URL,
	captureCodexInput,
	isTrustedModel,
	type JsonObject,
	parseCheckpoint,
	type RemoteCheckpoint,
	requestRemoteCompaction,
} from "./src/remote.ts";

type AgentMessage =
	SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringHeaders(
	headers: ProviderHeaders | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const entries = Object.entries(headers).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
	return entries.length ? Object.fromEntries(entries) : undefined;
}

function checkpointFromEntry(
	entry: unknown,
):
	| { state: "none" }
	| { state: "invalid" }
	| { state: "valid"; checkpoint: RemoteCheckpoint } {
	if (!isRecord(entry) || entry.type !== "compaction") return { state: "none" };
	if (!isRecord(entry.details) || !("remoteCompaction" in entry.details))
		return { state: "invalid" };
	const checkpoint = parseCheckpoint(entry.details.remoteCompaction);
	return checkpoint ? { state: "valid", checkpoint } : { state: "invalid" };
}

function latestCompaction(branch: unknown[]): unknown {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (isRecord(entry) && entry.type === "compaction") return entry;
	}
	return undefined;
}

function summaryItem(item: unknown, summary: string): boolean {
	if (!isRecord(item) || item.role !== "user" || !Array.isArray(item.content))
		return false;
	if (item.type !== undefined && item.type !== "message") return false;
	const expected =
		COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX;
	if (item.content.length !== 1) return false;
	const part = item.content[0];
	return isRecord(part) && part.type === "input_text" && part.text === expected;
}

async function identity(
	ctx: ExtensionContext,
	model: Model<Api>,
): Promise<
	| {
			apiKey: string;
			accountId: string;
			fingerprint: string;
			headers?: Record<string, string>;
			env?: Record<string, string>;
	  }
	| undefined
> {
	if (!isTrustedModel(model) || !ctx.modelRegistry.isUsingOAuth(model))
		return undefined;
	const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!resolved.ok || !resolved.apiKey) return undefined;
	if (
		resolved.baseUrl !== undefined &&
		resolved.baseUrl.replace(/\/+$/, "") !== CODEX_BASE_URL
	)
		return undefined;
	const accountId = accountIdFromToken(resolved.apiKey);
	if (!accountId) return undefined;
	const headers = stringHeaders(resolved.headers);
	return {
		apiKey: resolved.apiKey,
		accountId,
		fingerprint: accountFingerprint(accountId),
		...(headers ? { headers } : {}),
		...(resolved.env ? { env: resolved.env } : {}),
	};
}

function checkpointCompatible(
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

function addCumulativeFiles(
	fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> },
	entry: unknown,
): void {
	if (isRecord(entry) && isRecord(entry.details)) {
		if (Array.isArray(entry.details.readFiles)) {
			for (const path of entry.details.readFiles)
				if (typeof path === "string") fileOps.read.add(path);
		}
		if (Array.isArray(entry.details.modifiedFiles)) {
			for (const path of entry.details.modifiedFiles)
				if (typeof path === "string") fileOps.edited.add(path);
		}
	}
}

function preparationWithCumulativeFiles<
	T extends {
		fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
	},
>(preparation: T, entry: unknown): T {
	const fileOps = {
		read: new Set(preparation.fileOps.read),
		written: new Set(preparation.fileOps.written),
		edited: new Set(preparation.fileOps.edited),
	};
	addCumulativeFiles(fileOps, entry);
	return { ...preparation, fileOps };
}

function tailIsCompatible(
	branch: unknown[],
	compactionEntry: unknown,
	model: Model<Api>,
): boolean {
	const index = branch.indexOf(compactionEntry);
	if (index < 0) return false;
	for (const entry of branch.slice(index + 1)) {
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

export interface CodexCompactionDependencies {
	fetch?: typeof fetch;
	timeoutMs?: number;
	nativeCompact?: typeof compact;
}

export function createCodexCompactionExtension(
	dependencies: CodexCompactionDependencies = {},
) {
	return (pi: ExtensionAPI): void => {
		let suppressReplay = 0;
		const runNativeCompact = dependencies.nativeCompact ?? compact;

		pi.on("session_before_compact", async (event, ctx) => {
			const latest = latestCompaction(event.branchEntries);
			const prior = checkpointFromEntry(latest);
			// Pi skips cumulative details from extension-created compactions. Restore
			// only this extension's validated checkpoint metadata before delegating.
			if (prior.state === "valid")
				addCumulativeFiles(event.preparation.fileOps, latest);
			if (event.customInstructions !== undefined) return;
			const model = ctx.model;
			if (!model) return;
			const auth = await identity(ctx, model);
			if (!auth) return;

			// A previous readable summary without a usable opaque checkpoint means that
			// remote compaction would silently forget already-discarded history.
			if (event.preparation.previousSummary && prior.state !== "valid") return;
			if (prior.state === "invalid") return;
			if (
				prior.state === "valid" &&
				(!checkpointCompatible(prior.checkpoint, model, auth.fingerprint) ||
					!tailIsCompatible(event.branchEntries, latest, model))
			)
				return;

			const nativePreparation = preparationWithCumulativeFiles(
				event.preparation,
				latest,
			);
			const discarded: AgentMessage[] = [
				...event.preparation.messagesToSummarize,
				...(event.preparation.isSplitTurn
					? event.preparation.turnPrefixMessages
					: []),
			];
			if (discarded.length === 0) return;

			suppressReplay += 1;
			try {
				const nativePromise = runNativeCompact(
					nativePreparation,
					model,
					auth.apiKey,
					auth.headers,
					undefined,
					event.signal,
					ctx.thinkingLevel,
					undefined,
					auth.env,
				);
				const remotePromise = (async () => {
					const active = new Set(pi.getActiveTools());
					const tools = pi
						.getAllTools()
						.filter((tool) => active.has(tool.name))
						.map((tool) => ({
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters,
						}));
					const captured = await captureCodexInput(
						model,
						discarded,
						auth.apiKey,
						{
							signal: event.signal,
							systemPrompt: ctx.getSystemPrompt(),
							tools,
							...(ctx.thinkingLevel && ctx.thinkingLevel !== "off"
								? { reasoning: ctx.thinkingLevel }
								: {}),
						},
					);
					const remoteInput =
						prior.state === "valid"
							? [prior.checkpoint.item, ...captured.input]
							: captured.input;
					const item = await requestRemoteCompaction(
						captured.template,
						remoteInput,
						{ accessToken: auth.apiKey, accountId: auth.accountId },
						{
							...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
							...(dependencies.timeoutMs !== undefined
								? { timeoutMs: dependencies.timeoutMs }
								: {}),
							signal: event.signal,
						},
					);
					return item;
				})();
				const [native, remote] = await Promise.allSettled([
					nativePromise,
					remotePromise,
				]);
				if (event.signal.aborted || native.status !== "fulfilled") return;
				if (remote.status !== "fulfilled") return { compaction: native.value };
				return {
					compaction: {
						...native.value,
						details: {
							...(isRecord(native.value.details) ? native.value.details : {}),
							remoteCompaction: {
								version: 1,
								provider: "openai-codex",
								api: "openai-codex-responses",
								model: model.id,
								endpoint: CODEX_RESPONSES_URL,
								authMode: "oauth",
								accountFingerprint: auth.fingerprint,
								item: remote.value,
							},
						},
					},
				};
			} finally {
				suppressReplay -= 1;
			}
		});

		pi.on("before_provider_request", async (event, ctx) => {
			if (
				suppressReplay > 0 ||
				!ctx.model ||
				!isRecord(event.payload) ||
				!Array.isArray(event.payload.input)
			)
				return;
			const model = ctx.model;
			const branch = ctx.sessionManager.getBranch();
			const entry = latestCompaction(branch);
			const parsed = checkpointFromEntry(entry);
			// Deliberately do not search older entries: a latest malformed or native
			// checkpoint is a hard replay boundary.
			if (parsed.state !== "valid" || !tailIsCompatible(branch, entry, model))
				return;
			const auth = await identity(ctx, model);
			if (
				!auth ||
				!checkpointCompatible(parsed.checkpoint, model, auth.fingerprint)
			)
				return;
			if (!isRecord(entry) || typeof entry.summary !== "string") return;
			const summaryIndexes = event.payload.input.flatMap((item, index) =>
				summaryItem(item, entry.summary as string) ? [index] : [],
			);
			if (summaryIndexes.length !== 1 || summaryIndexes[0] !== 0) return;
			const index = 0;
			const replacement: JsonObject = {
				...event.payload,
				input: [
					...event.payload.input.slice(0, index),
					structuredClone(parsed.checkpoint.item),
					...event.payload.input.slice(index + 1),
				],
			};
			delete replacement.previous_response_id;
			return replacement;
		});
	};
}

export default createCodexCompactionExtension();
export { parseCheckpoint, requestRemoteCompaction } from "./src/remote.ts";
