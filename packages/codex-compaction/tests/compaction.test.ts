import assert from "node:assert/strict";
import test from "node:test";
import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createCodexCompactionExtension } from "../index.ts";
import { CODEX_RESPONSES_URL } from "../src/remote.ts";

type RemoteDetails = {
	remoteCompaction?: { item: { encrypted_content: string } };
};
type SessionBeforeCompactResult = {
	cancel?: boolean;
	compaction?: CompactionResult<RemoteDetails>;
};

const jwt = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.y`;
const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.4",
	name: "Codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
};
const user = (text: string) => ({
	role: "user" as const,
	content: text,
	timestamp: 1,
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
	} = {},
) {
	const handlers = new Map<
		string,
		ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>
	>();
	let sentBody: { input: Array<Record<string, unknown>> } = { input: [] };
	let nativePreparation: SessionBeforeCompactEvent["preparation"] | undefined;
	let nativeCalls = 0;
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
	const pi = {
		on(
			name: string,
			handler: ExtensionHandler<
				SessionBeforeCompactEvent,
				SessionBeforeCompactResult
			>,
		) {
			handlers.set(name, handler);
		},
		getActiveTools: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	createCodexCompactionExtension({
		...(options.remoteGraceMs !== undefined
			? { remoteGraceMs: options.remoteGraceMs }
			: {}),
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
			if (options.fetch) return options.fetch(init?.signal as AbortSignal);
			if (options.remoteFails) return new Response("failure", { status: 500 });
			return new Response(
				`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "compaction", encrypted_content: "new" }] } })}\n\n`,
				{ status: 200 },
			);
		},
	})(pi);
	const ctx = {
		model,
		thinkingLevel: "low",
		getSystemPrompt: () => "system",
		modelRegistry: {
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => {
				if (options.authDelay) await options.authDelay;
				if (options.authReject) throw new Error("auth unavailable");
				return {
					ok: true,
					apiKey: jwt,
					baseUrl: "https://chatgpt.com/backend-api",
				};
			},
		},
	} as unknown as ExtensionContext;
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
		handler: handlers.get("session_before_compact") as ExtensionHandler<
			SessionBeforeCompactEvent,
			SessionBeforeCompactResult
		>,
		ctx,
		preparation,
		prior,
		getBody: () => sentBody,
		getNative: () => nativePreparation,
		getNativeCalls: () => nativeCalls,
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const compactResult = {
	summary: "portable",
	firstKeptEntryId: "kept",
	tokensBefore: 10,
	details: { readFiles: ["new.ts"], modifiedFiles: [] },
};

async function invoke(
	state: ReturnType<typeof fixture>,
	signal = new AbortController().signal,
) {
	return state.handler(
		{
			type: "session_before_compact",
			preparation: state.preparation,
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal,
		},
		state.ctx,
	);
}

test("auth resolver rejection falls back without native or remote work", async () => {
	const state = fixture({ authReject: true });
	assert.equal(await invoke(state), undefined);
	assert.equal(state.getNativeCalls(), 0);
	assert.deepEqual(state.getBody().input, []);
});

test("auth cancellation leaves no native or remote work", async () => {
	const delayed = deferred<never>();
	const state = fixture({ authDelay: delayed.promise });
	const controller = new AbortController();
	const resultPromise = invoke(state, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort(new DOMException("cancelled", "AbortError"));
	assert.equal(await resultPromise, undefined);
	assert.equal(state.getNativeCalls(), 0);
	assert.deepEqual(state.getBody().input, []);
	delayed.reject(new Error("late auth failure"));
});

test("remote grace timeout returns native summary promptly and aborts remote request", async () => {
	const remote = deferred<Response>();
	let remoteSignal!: AbortSignal;
	const state = fixture({
		remoteGraceMs: 5,
		fetch: (signal) => {
			remoteSignal = signal;
			return remote.promise;
		},
	});
	const result = await invoke(state);
	assert.equal(result?.compaction?.summary, "portable");
	assert.equal(remoteSignal.aborted, true);
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
	await new Promise((resolve) => setTimeout(resolve, 0));
	native.resolve(compactResult);
	assert.equal((await resultPromise)?.compaction?.summary, "portable");
});

test("caller abort during native and remote work never returns successful compaction", async () => {
	const native = deferred<typeof compactResult>();
	const remote = deferred<Response>();
	const controller = new AbortController();
	const state = fixture({
		remoteGraceMs: 5,
		nativeCompact: () => native.promise,
		fetch: (signal) => pendingUntilAbort(signal),
	});
	const resultPromise = invoke(state, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort();
	native.resolve(compactResult);
	assert.equal(await resultPromise, undefined);
	remote.resolve(new Response("late", { status: 500 }));
});

test("native rejection aborts remote work and does not suppress subsequent compaction", async () => {
	let remoteSignal: AbortSignal | undefined;
	const started = deferred<void>();
	let calls = 0;
	const state = fixture({
		remoteGraceMs: 5,
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
	assert.equal((await invoke(state))?.compaction?.summary, "portable");
	assert.equal(calls, 2);
});

test("hybrid compacts only discarded prefix plus split prefix and keeps portable summary", async () => {
	const state = fixture();
	const result = await state.handler(
		{
			type: "session_before_compact",
			preparation: state.preparation,
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		},
		state.ctx,
	);
	assert.ok(result?.compaction);
	assert.equal(result.compaction.summary, "portable");
	assert.equal(
		result.compaction.details?.remoteCompaction?.item.encrypted_content,
		"new",
	);
	const input = state.getBody().input;
	assert.match(JSON.stringify(input), /discarded/);
	assert.match(JSON.stringify(input), /split-prefix/);
	assert.doesNotMatch(JSON.stringify(input), /kept-tail/);
	assert.deepEqual(input.at(-1), { type: "compaction_trigger" });
});

test("successive compaction seeds prior checkpoint and merges cumulative file operations", async () => {
	const state = fixture({ previous: true });
	await state.handler(
		{
			type: "session_before_compact",
			preparation: state.preparation,
			branchEntries: state.prior ? [state.prior] : [],
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		},
		state.ctx,
	);
	assert.equal(state.getBody().input[0]?.encrypted_content, "previous");
	const nativePreparation = state.getNative();
	assert.ok(nativePreparation);
	assert.equal(nativePreparation.fileOps.read.has("old-read.ts"), true);
	assert.equal(nativePreparation.fileOps.edited.has("old-write.ts"), true);
});

test("remote failure retains native result and custom instructions delegate entirely to Pi", async () => {
	const state = fixture({ remoteFails: true });
	const result = await state.handler(
		{
			type: "session_before_compact",
			preparation: state.preparation,
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		},
		state.ctx,
	);
	assert.ok(result?.compaction);
	assert.equal(result.compaction.summary, "portable");
	assert.equal(result.compaction.details?.remoteCompaction, undefined);
	assert.equal(
		await state.handler(
			{
				type: "session_before_compact",
				preparation: state.preparation,
				branchEntries: [],
				customInstructions: "focus",
				reason: "manual",
				willRetry: false,
				signal: new AbortController().signal,
			},
			state.ctx,
		),
		undefined,
	);

	const afterHybrid = fixture({ previous: true });
	assert.equal(
		await afterHybrid.handler(
			{
				type: "session_before_compact",
				preparation: afterHybrid.preparation,
				branchEntries: afterHybrid.prior ? [afterHybrid.prior] : [],
				customInstructions: "native boundary",
				reason: "manual",
				willRetry: false,
				signal: new AbortController().signal,
			},
			afterHybrid.ctx,
		),
		undefined,
	);
	assert.equal(afterHybrid.preparation.fileOps.read.has("old-read.ts"), true);
	assert.equal(
		afterHybrid.preparation.fileOps.edited.has("old-write.ts"),
		true,
	);
});
