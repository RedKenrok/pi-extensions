import assert from "node:assert/strict";
import test from "node:test";
import type {
	CompactionResult,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { deferred, nextTurn } from "../../../test-support/async.ts";
import { jwt } from "../../../test-support/jwt.ts";
import { sseEvent } from "../../../test-support/streams.ts";
import { createCodexCompactionExtension } from "../index.ts";
import type { FallbackReason } from "../src/debug.ts";
import { CODEX_RESPONSES_URL } from "../src/remote.ts";
import {
	CODEX_BASE,
	type CompactResult,
	fakeContext,
	fakePi,
	model,
} from "./fakes.ts";

const user = (text: string) => ({
	role: "user" as const,
	content: text,
	timestamp: 1,
});

const completedSse = (output: unknown[], usage?: unknown) =>
	sseEvent("response.completed", {
		type: "response.completed",
		response: {
			status: "completed",
			output,
			...(usage !== undefined ? { usage } : {}),
		},
	});

function fixture(
	options: {
		remoteFails?: boolean;
		previous?: boolean;
		remoteGraceMs?: number;
		nativeCompact?: (
			preparation: SessionBeforeCompactEvent["preparation"],
		) => Promise<CompactionResult>;
		fetch?: (signal: AbortSignal) => Promise<Response>;
		authReject?: boolean;
		authDelay?: Promise<never>;
		authHeaders?: Record<string, string | null>;
		usage?: unknown;
	} = {},
) {
	let sentBody: { input: Array<Record<string, unknown>> } = { input: [] };
	let sentHeaders: Headers | undefined;
	let nativePreparation: SessionBeforeCompactEvent["preparation"] | undefined;
	let nativeCalls = 0;
	let authCalls = 0;
	const reasons: FallbackReason[] = [];
	const previousItem = { type: "compaction", encrypted_content: "previous" };
	const prior: SessionEntry | undefined = options.previous
		? {
				type: "compaction",
				id: "prior",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				firstKeptEntryId: "prior",
				tokensBefore: 10,
				summary: "old",
				details: {
					readFiles: ["old-read.ts"],
					modifiedFiles: ["old-write.ts"],
					remoteCompaction: {
						version: 1,
						provider: "openai-codex",
						api: "openai-codex-responses",
						model: model.id,
						endpoint: CODEX_RESPONSES_URL,
						authMode: "oauth",
						accountFingerprint: "3vCxf2Ayhe9DNvbj49zUPNGP14knernW4Ia35WdTniU",
						item: previousItem,
					},
				},
			}
		: undefined;
	const pi = fakePi();
	createCodexCompactionExtension({
		...(options.remoteGraceMs !== undefined
			? { remoteGraceMs: options.remoteGraceMs }
			: {}),
		debug: (reason) => reasons.push(reason),
		nativeCompact:
			options.nativeCompact ??
			(async (preparation: SessionBeforeCompactEvent["preparation"]) => {
				nativeCalls++;
				nativePreparation = preparation;
				return {
					summary: "portable",
					firstKeptEntryId: "kept",
					tokensBefore: 10,
					details: { readFiles: ["new.ts"], modifiedFiles: [] },
				};
			}),
		fetch: async (_url, init) => {
			sentBody = JSON.parse(String(init?.body));
			sentHeaders = new Headers(init?.headers);
			if (options.fetch) return options.fetch(init?.signal as AbortSignal);
			if (options.remoteFails) return new Response("failure", { status: 500 });
			return new Response(
				completedSse(
					[{ type: "compaction", encrypted_content: "new" }],
					options.usage,
				),
				{ status: 200 },
			);
		},
	})(pi.api);
	const ctx = fakeContext({
		getApiKeyAndHeaders: async () => {
			authCalls++;
			if (options.authDelay) await options.authDelay;
			if (options.authReject) throw new Error("auth unavailable");
			return {
				ok: true,
				apiKey: jwt("acct"),
				baseUrl: CODEX_BASE,
				...(options.authHeaders ? { headers: options.authHeaders } : {}),
			};
		},
	});
	const preparation = {
		firstKeptEntryId: "kept",
		messagesToSummarize: [user("discarded")],
		turnPrefixMessages: [user("split-prefix")],
		isSplitTurn: true,
		tokensBefore: 10,
		...(options.previous ? { previousSummary: "old" } : {}),
		fileOps: {
			read: new Set(["new.ts"]),
			written: new Set<string>(),
			edited: new Set<string>(),
		},
		settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
	};
	return {
		handler: pi.compactHandler(),
		ctx,
		preparation,
		prior,
		reasons,
		getBody: () => sentBody,
		getHeaders: () => sentHeaders,
		getNative: () => nativePreparation,
		getNativeCalls: () => nativeCalls,
		getAuthCalls: () => authCalls,
	};
}

function pendingUntilAbort(signal: AbortSignal): Promise<Response> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
	});
}

const compactResult = {
	summary: "portable",
	firstKeptEntryId: "kept",
	tokensBefore: 10,
	details: { readFiles: ["new.ts"], modifiedFiles: [] },
};

async function invoke(
	state: ReturnType<typeof fixture>,
	overrides: Partial<SessionBeforeCompactEvent> = {},
): Promise<CompactResult | undefined> {
	const result = await state.handler(
		{
			type: "session_before_compact",
			preparation: state.preparation,
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
			...overrides,
		},
		state.ctx,
	);
	return result ?? undefined;
}

test("invalid grace and timeout options are rejected when the extension is created", () => {
	for (const remoteGraceMs of [-1, 1.5, 60_001, Number.NaN])
		assert.throws(
			() => createCodexCompactionExtension({ remoteGraceMs }),
			RangeError,
		);
	for (const timeoutMs of [0, 999, 600_001, Number.POSITIVE_INFINITY])
		assert.throws(
			() => createCodexCompactionExtension({ timeoutMs }),
			RangeError,
		);
	assert.doesNotThrow(() =>
		createCodexCompactionExtension({ remoteGraceMs: 0, timeoutMs: 1_000 }),
	);
});

test("auth resolver rejection falls back without native or remote work", async () => {
	const state = fixture({ authReject: true });
	assert.equal(await invoke(state), undefined);
	assert.equal(state.getNativeCalls(), 0);
	assert.deepEqual(state.getBody().input, []);
	assert.deepEqual(state.reasons, ["auth_unavailable"]);
});

test("auth cancellation leaves no native or remote work", async () => {
	const delayed = deferred<never>();
	const state = fixture({ authDelay: delayed.promise });
	const controller = new AbortController();
	const resultPromise = invoke(state, { signal: controller.signal });
	await nextTurn();
	controller.abort(new DOMException("cancelled", "AbortError"));
	assert.equal(await resultPromise, undefined);
	assert.equal(state.getNativeCalls(), 0);
	assert.deepEqual(state.getBody().input, []);
	assert.deepEqual(state.reasons, ["aborted"]);
	delayed.reject(new Error("late auth failure"));
});

test("a hung auth resolver is bounded and shared instead of restarted", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const hung = deferred<never>();
	const state = fixture({ authDelay: hung.promise });
	const first = invoke(state);
	await nextTurn();
	t.mock.timers.tick(10_000);
	assert.equal(await first, undefined);
	const second = invoke(state);
	await nextTurn();
	t.mock.timers.tick(10_000);
	assert.equal(await second, undefined);
	assert.equal(state.getAuthCalls(), 1);
	assert.deepEqual(state.reasons, ["auth_unavailable", "auth_unavailable"]);
	hung.reject(new Error("late"));
	await nextTurn();
});

test("remote grace timeout returns native summary promptly and aborts remote request", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const remote = deferred<Response>();
	let remoteSignal!: AbortSignal;
	const state = fixture({
		remoteGraceMs: 5_000,
		fetch: (signal) => {
			remoteSignal = signal;
			return remote.promise;
		},
	});
	let settled = false;
	const pending = invoke(state).finally(() => {
		settled = true;
	});
	// The grace timer is armed only after native compaction resolves, a few
	// turns in; advancing just short of the window must not end it early.
	for (let turn = 0; turn < 10; turn++) await nextTurn();
	t.mock.timers.tick(4_999);
	await nextTurn();
	assert.equal(settled, false);
	t.mock.timers.tick(1);
	const result = await pending;
	assert.equal(result?.compaction?.summary, "portable");
	assert.equal(
		result?.compaction?.details?.fallbackReason,
		"remote_grace_elapsed",
	);
	assert.equal(result?.compaction?.details?.remoteCompaction, undefined);
	assert.equal(remoteSignal.aborted, true);
	assert.deepEqual(state.reasons, ["remote_grace_elapsed"]);
	remote.resolve(new Response("late", { status: 500 }));
});

test("early remote rejection is handled while native compaction is pending", async () => {
	const native = deferred<typeof compactResult>();
	const state = fixture({
		nativeCompact: () => native.promise,
		fetch: async () => {
			throw new Error("remote failed");
		},
	});
	const resultPromise = invoke(state);
	await nextTurn();
	native.resolve(compactResult);
	const result = await resultPromise;
	assert.equal(result?.compaction?.summary, "portable");
	assert.equal(result?.compaction?.details?.fallbackReason, "remote_failed");
});

test("caller abort during native and remote work never returns successful compaction", async () => {
	const native = deferred<typeof compactResult>();
	const controller = new AbortController();
	let remoteSignal: AbortSignal | undefined;
	const state = fixture({
		remoteGraceMs: 60_000,
		nativeCompact: () => native.promise,
		fetch: (signal) => {
			remoteSignal = signal;
			return pendingUntilAbort(signal);
		},
	});
	const resultPromise = invoke(state, { signal: controller.signal });
	await nextTurn();
	controller.abort();
	native.resolve(compactResult);
	assert.equal(await resultPromise, undefined);
	assert.equal(remoteSignal?.aborted, true);
	assert.deepEqual(state.reasons, ["aborted"]);
});

test("caller abort during the grace window discards both results", async () => {
	const controller = new AbortController();
	const state = fixture({
		remoteGraceMs: 60_000,
		fetch: (signal) => {
			queueMicrotask(() => controller.abort());
			return pendingUntilAbort(signal);
		},
	});
	assert.equal(await invoke(state, { signal: controller.signal }), undefined);
	assert.deepEqual(state.reasons, ["aborted"]);
});

test("native rejection aborts remote work and does not suppress subsequent compaction", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let remoteSignal: AbortSignal | undefined;
	const started = deferred<void>();
	let calls = 0;
	const state = fixture({
		remoteGraceMs: 60_000,
		nativeCompact: async () => {
			calls++;
			if (calls === 1) {
				await started.promise;
				throw new Error("native failed");
			}
			return compactResult;
		},
		fetch: (signal) => {
			remoteSignal = signal;
			started.resolve();
			return pendingUntilAbort(signal);
		},
	});
	assert.equal(await invoke(state), undefined);
	assert.ok(remoteSignal);
	assert.equal(remoteSignal.aborted, true);
	// The second remote request never answers, so its grace window elapses.
	const second = invoke(state);
	for (let turn = 0; turn < 10; turn++) await nextTurn();
	t.mock.timers.tick(60_000);
	assert.equal((await second)?.compaction?.summary, "portable");
	assert.equal(calls, 2);
	assert.deepEqual(state.reasons, ["native_failed", "remote_grace_elapsed"]);
});

test("hybrid compacts only discarded prefix plus split prefix and keeps portable summary", async () => {
	const state = fixture();
	const result = await invoke(state);
	assert.ok(result?.compaction);
	assert.equal(result.compaction.summary, "portable");
	assert.equal(
		result.compaction.details?.remoteCompaction?.item.encrypted_content,
		"new",
	);
	assert.equal(result.compaction.details?.fallbackReason, undefined);
	assert.equal(result.compaction.details?.remoteCompaction?.usage, undefined);
	const input = state.getBody().input;
	assert.match(JSON.stringify(input), /discarded/);
	assert.match(JSON.stringify(input), /split-prefix/);
	assert.doesNotMatch(JSON.stringify(input), /kept-tail/);
	assert.deepEqual(input.at(-1), { type: "compaction_trigger" });
	assert.deepEqual(state.reasons, []);
});

test("remote usage is recorded on the checkpoint when the backend reports it", async () => {
	const usage = { input_tokens: 12, output_tokens: 3 };
	const result = await invoke(fixture({ usage }));
	assert.deepEqual(result?.compaction?.details?.remoteCompaction?.usage, usage);
	const oversized = await invoke(
		fixture({ usage: { padding: "x".repeat(5_000) } }),
	);
	assert.equal(
		oversized?.compaction?.details?.remoteCompaction?.usage,
		undefined,
	);
	assert.ok(oversized?.compaction?.details?.remoteCompaction);
});

test("resolver headers are forwarded only when they are strings", async () => {
	const state = fixture({
		authHeaders: { "X-Provider-Region": "eu", "X-Removed": null },
	});
	await invoke(state);
	assert.equal(state.getHeaders()?.get("x-provider-region"), "eu");
	assert.equal(state.getHeaders()?.has("x-removed"), false);
});

test("successive compaction seeds prior checkpoint and merges cumulative file operations", async () => {
	const state = fixture({ previous: true });
	await invoke(state, {
		branchEntries: state.prior ? [state.prior] : [],
		reason: "threshold",
	});
	assert.equal(state.getBody().input[0]?.encrypted_content, "previous");
	const nativePreparation = state.getNative();
	assert.ok(nativePreparation);
	assert.equal(nativePreparation.fileOps.read.has("old-read.ts"), true);
	assert.equal(nativePreparation.fileOps.edited.has("old-write.ts"), true);
});

test("a checkpoint from another account falls back before any model work", async () => {
	const state = fixture({ previous: true });
	const prior = state.prior as SessionEntry & {
		details: { remoteCompaction: { accountFingerprint: string } };
	};
	prior.details.remoteCompaction.accountFingerprint = "someone-else";
	assert.equal(await invoke(state, { branchEntries: [prior] }), undefined);
	assert.equal(state.getNativeCalls(), 0);
	assert.deepEqual(state.reasons, ["checkpoint_incompatible"]);
});

test("remote failure retains native result and custom instructions delegate entirely to Pi", async () => {
	const state = fixture({ remoteFails: true });
	const result = await invoke(state);
	assert.ok(result?.compaction);
	assert.equal(result.compaction.summary, "portable");
	assert.equal(result.compaction.details?.remoteCompaction, undefined);
	assert.equal(result.compaction.details?.fallbackReason, "remote_failed");
	assert.equal(await invoke(state, { customInstructions: "focus" }), undefined);
	assert.deepEqual(state.reasons, ["remote_failed", "custom_instructions"]);

	const afterHybrid = fixture({ previous: true });
	assert.equal(
		await invoke(afterHybrid, {
			branchEntries: afterHybrid.prior ? [afterHybrid.prior] : [],
			customInstructions: "native boundary",
		}),
		undefined,
	);
	assert.equal(afterHybrid.preparation.fileOps.read.has("old-read.ts"), true);
	assert.equal(
		afterHybrid.preparation.fileOps.edited.has("old-write.ts"),
		true,
	);
	assert.equal(afterHybrid.getAuthCalls(), 0);
});
