import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import {
	type CompactionResult,
	compact,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	addCumulativeFiles,
	checkpointCompatible,
	checkpointFromEntry,
	latestCompaction,
	planRemoteCompaction,
	type RemotePlan,
	tailIsCompatible,
} from "./src/branch.ts";
import {
	createDebugSink,
	type DebugSink,
	type FallbackReason,
} from "./src/debug.ts";
import {
	accountFingerprint,
	accountIdFromToken,
	buildCheckpoint,
	CODEX_BASE_URL,
	captureCodexInput,
	isRecord,
	isTrustedModel,
	type JsonObject,
	type RemoteCheckpoint,
	requestRemoteCompaction,
	validateTimeoutMs,
} from "./src/remote.ts";

// Pi does not export these from its public entry point. They must match the
// wrapper Pi's convertToLlm puts around a compaction summary exactly;
// tests/contract.test.ts checks that against the installed Pi.
const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

const AUTH_RESOLUTION_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_GRACE_MS = 5_000;
const MAX_REMOTE_GRACE_MS = 60_000;

type AuthRegistry = Pick<
	ExtensionContext["modelRegistry"],
	"isUsingOAuth" | "getApiKeyAndHeaders"
>;
type ResolvedAuth = Awaited<ReturnType<AuthRegistry["getApiKeyAndHeaders"]>>;

interface Identity {
	apiKey: string;
	accountId: string;
	fingerprint: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

export function summaryItem(item: unknown, summary: string): boolean {
	if (!isRecord(item) || item.role !== "user" || !Array.isArray(item.content))
		return false;
	if (item.type !== undefined && item.type !== "message") return false;
	const expected =
		COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX;
	if (item.content.length !== 1) return false;
	const part = item.content[0];
	return isRecord(part) && part.type === "input_text" && part.text === expected;
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

/**
 * Resolves to undefined when the signal aborts or the deadline passes. The
 * underlying promise cannot be cancelled and keeps running; callers share it
 * instead of starting another one (see resolveShared below).
 */
function settleWithin<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T | undefined> {
	if (signal?.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const finish = (value: T | undefined) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => finish(undefined);
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(finish, () => finish(undefined));
	});
}

function withFallbackReason(
	result: CompactionResult,
	reason: FallbackReason,
): CompactionResult {
	return {
		...result,
		details: {
			...(isRecord(result.details) ? result.details : {}),
			fallbackReason: reason,
		},
	};
}

export interface CodexCompactionDependencies {
	fetch?: typeof fetch;
	timeoutMs?: number;
	remoteGraceMs?: number;
	nativeCompact?: typeof compact;
	/** Receives fallback reason codes; defaults to stderr when PI_EXT_DEBUG enables this package. */
	debug?: DebugSink;
}

export function createCodexCompactionExtension(
	dependencies: CodexCompactionDependencies = {},
) {
	const graceMs = dependencies.remoteGraceMs ?? DEFAULT_REMOTE_GRACE_MS;
	if (
		!Number.isInteger(graceMs) ||
		graceMs < 0 ||
		graceMs > MAX_REMOTE_GRACE_MS
	)
		throw new RangeError(
			`remoteGraceMs must be an integer from 0 to ${MAX_REMOTE_GRACE_MS}`,
		);
	if (dependencies.timeoutMs !== undefined)
		validateTimeoutMs(dependencies.timeoutMs);

	return (pi: ExtensionAPI): void => {
		// Pi's native compact() and this extension's payload capture both bypass
		// Pi's before_provider_request hook, and Pi rejects prompts while a
		// compaction runs. The counter is therefore a defensive guard: nothing
		// should be replayed from a checkpoint that is about to be superseded.
		// Pi builds one extension instance per session runner, so a plain
		// counter is already scoped to one session.
		let suppressReplay = 0;
		const runNativeCompact = dependencies.nativeCompact ?? compact;
		const debug = dependencies.debug ?? createDebugSink();
		const pendingResolutions = new Map<
			string,
			Promise<ResolvedAuth | undefined>
		>();
		let lastAccount:
			| { apiKey: string; accountId: string; fingerprint: string }
			| undefined;
		let replayCache:
			| {
					key: string;
					checkpoint: RemoteCheckpoint | undefined;
					summary: string | undefined;
			  }
			| undefined;

		const fallback = (reason: FallbackReason): undefined => {
			debug(reason);
			return undefined;
		};

		// The registry resolver is not required to accept an AbortSignal, so a
		// timed-out resolution may still be running. Sharing it prevents every
		// later request from stacking another background resolution.
		const resolveShared = (
			registry: AuthRegistry,
			model: Model<Api>,
		): Promise<ResolvedAuth | undefined> => {
			const key = `${model.provider}\u0000${model.id}`;
			let pending = pendingResolutions.get(key);
			if (!pending) {
				pending = Promise.resolve()
					.then(() => registry.getApiKeyAndHeaders(model))
					.catch(() => undefined)
					.finally(() => pendingResolutions.delete(key));
				pendingResolutions.set(key, pending);
			}
			return pending;
		};

		const accountFor = (apiKey: string) => {
			if (lastAccount?.apiKey === apiKey) return lastAccount;
			const accountId = accountIdFromToken(apiKey);
			if (!accountId) return undefined;
			lastAccount = {
				apiKey,
				accountId,
				fingerprint: accountFingerprint(accountId),
			};
			return lastAccount;
		};

		// Resolver failures are deliberately converted to the native-compaction
		// fallback rather than surfaced, since native compaction still works.
		const identity = async (
			registry: AuthRegistry,
			model: Model<Api>,
			signal?: AbortSignal,
		): Promise<Identity | undefined> => {
			if (
				!isTrustedModel(model) ||
				!registry.isUsingOAuth(model) ||
				signal?.aborted
			)
				return undefined;
			const resolved = await settleWithin(
				resolveShared(registry, model),
				AUTH_RESOLUTION_TIMEOUT_MS,
				signal,
			);
			if (signal?.aborted || !resolved?.ok || !resolved.apiKey)
				return undefined;
			if (
				resolved.baseUrl !== undefined &&
				resolved.baseUrl.replace(/\/+$/, "") !== CODEX_BASE_URL
			)
				return undefined;
			const account = accountFor(resolved.apiKey);
			if (!account) return undefined;
			const headers = stringHeaders(resolved.headers);
			return {
				apiKey: resolved.apiKey,
				accountId: account.accountId,
				fingerprint: account.fingerprint,
				...(headers ? { headers } : {}),
				...(resolved.env ? { env: resolved.env } : {}),
			};
		};

		const runHybrid = async (
			plan: Extract<RemotePlan, { ok: true }>,
			auth: Identity,
			event: SessionBeforeCompactEvent,
			ctx: ExtensionContext,
		) => {
			const { model } = plan;
			const remoteController = new AbortController();
			const remoteSignal = AbortSignal.any([
				event.signal,
				remoteController.signal,
			]);
			let usage: JsonObject | undefined;
			const nativePromise = runNativeCompact(
				event.preparation,
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
					plan.discarded,
					auth.apiKey,
					{
						signal: remoteSignal,
						systemPrompt: ctx.getSystemPrompt(),
						tools,
						...(ctx.thinkingLevel && ctx.thinkingLevel !== "off"
							? { reasoning: ctx.thinkingLevel }
							: {}),
					},
				);
				return requestRemoteCompaction(
					captured.template,
					plan.prior ? [plan.prior.item, ...captured.input] : captured.input,
					{ accessToken: auth.apiKey, accountId: auth.accountId },
					{
						...(auth.headers ? { headers: auth.headers } : {}),
						...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
						...(dependencies.timeoutMs !== undefined
							? { timeoutMs: dependencies.timeoutMs }
							: {}),
						signal: remoteSignal,
						onUsage: (value) => {
							usage = value;
						},
					},
				);
			})();
			// Attaching both handlers immediately means an early remote rejection
			// is never reported as unhandled while native compaction is pending.
			const settledRemote = remotePromise.then(
				(value) => ({ status: "fulfilled" as const, value }),
				() => ({ status: "rejected" as const }),
			);
			const native = await nativePromise.then(
				(value) => ({ ok: true as const, value }),
				() => ({ ok: false as const }),
			);
			if (event.signal.aborted) {
				remoteController.abort(event.signal.reason);
				return fallback("aborted");
			}
			if (!native.ok) {
				remoteController.abort(new Error("Native compaction failed"));
				return fallback("native_failed");
			}
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const remote = await Promise.race([
				settledRemote,
				new Promise<{ status: "timeout" }>((resolve) => {
					graceTimer = setTimeout(
						() => resolve({ status: "timeout" }),
						graceMs,
					);
				}),
			]);
			clearTimeout(graceTimer);
			if (event.signal.aborted) {
				remoteController.abort(event.signal.reason);
				return fallback("aborted");
			}
			if (remote.status !== "fulfilled") {
				remoteController.abort(
					new DOMException(
						"Remote compaction grace period elapsed",
						"TimeoutError",
					),
				);
				const reason =
					remote.status === "timeout"
						? "remote_grace_elapsed"
						: "remote_failed";
				debug(reason);
				return { compaction: withFallbackReason(native.value, reason) };
			}
			return {
				compaction: {
					...native.value,
					details: {
						...(isRecord(native.value.details) ? native.value.details : {}),
						remoteCompaction: buildCheckpoint(
							model.id,
							auth.fingerprint,
							remote.value,
							usage,
						),
					},
				},
			};
		};

		pi.on("session_before_compact", async (event, ctx) => {
			const latest = latestCompaction(event.branchEntries);
			const prior = checkpointFromEntry(latest);
			if (prior.state === "valid" && latest)
				addCumulativeFiles(event.preparation.fileOps, latest.entry);
			const plan = planRemoteCompaction(event, ctx.model, latest, prior);
			if (!plan.ok) return fallback(plan.reason);
			const auth = await identity(ctx.modelRegistry, plan.model, event.signal);
			if (event.signal.aborted) return fallback("aborted");
			if (!auth) return fallback("auth_unavailable");
			if (
				plan.prior &&
				!checkpointCompatible(plan.prior, plan.model, auth.fingerprint)
			)
				return fallback("checkpoint_incompatible");
			suppressReplay += 1;
			try {
				return await runHybrid(plan, auth, event, ctx);
			} finally {
				suppressReplay -= 1;
			}
		});

		// The branch is a root-to-leaf path, so the leaf id plus length and the
		// active model fully determine whether the latest checkpoint may be
		// replayed. Entries without an id are not cached.
		const replayable = (
			branch: readonly unknown[],
			model: Model<Api>,
		): { checkpoint: RemoteCheckpoint; summary: string } | undefined => {
			const leaf = branch.at(-1);
			const leafId =
				isRecord(leaf) && typeof leaf.id === "string" ? leaf.id : undefined;
			const key =
				leafId === undefined
					? undefined
					: [leafId, branch.length, model.provider, model.id, model.api].join(
							"\u0000",
						);
			if (key !== undefined && replayCache?.key === key)
				return replayCache.checkpoint && replayCache.summary !== undefined
					? { checkpoint: replayCache.checkpoint, summary: replayCache.summary }
					: undefined;
			const latest = latestCompaction(branch);
			const parsed = checkpointFromEntry(latest);
			// Deliberately do not search older entries: a latest malformed or native
			// checkpoint is a hard replay boundary.
			const usable =
				parsed.state === "valid" &&
				latest !== undefined &&
				typeof latest.entry.summary === "string" &&
				tailIsCompatible(branch, latest, model)
					? {
							checkpoint: parsed.checkpoint,
							summary: latest.entry.summary as string,
						}
					: undefined;
			if (key !== undefined)
				replayCache = {
					key,
					checkpoint: usable?.checkpoint,
					summary: usable?.summary,
				};
			return usable;
		};

		pi.on("before_provider_request", async (event, ctx) => {
			const model = ctx.model;
			if (
				suppressReplay > 0 ||
				!model ||
				!isRecord(event.payload) ||
				!Array.isArray(event.payload.input) ||
				event.payload.model !== model.id
			)
				return;
			const usable = replayable(ctx.sessionManager.getBranch(), model);
			if (!usable) return;
			const auth = await identity(ctx.modelRegistry, model);
			if (
				!auth ||
				!checkpointCompatible(usable.checkpoint, model, auth.fingerprint)
			)
				return;
			const input = event.payload.input;
			const summaryIndexes = input.flatMap((item, index) =>
				summaryItem(item, usable.summary) ? [index] : [],
			);
			// Pi places the summary first; anything else means another extension
			// reshaped the payload and the substitution can no longer be proved safe.
			if (summaryIndexes.length !== 1 || summaryIndexes[0] !== 0) return;
			const replacement: JsonObject = {
				...event.payload,
				input: [structuredClone(usable.checkpoint.item), ...input.slice(1)],
			};
			delete replacement.previous_response_id;
			return replacement;
		});
	};
}

export default createCodexCompactionExtension();
export { parseCheckpoint, requestRemoteCompaction } from "./src/remote.ts";
