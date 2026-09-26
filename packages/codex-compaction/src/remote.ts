import { createHash } from "node:crypto";
import type { Api, Context, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	CODEX_BASE_URL,
	CODEX_RESPONSES_URL,
	codexRequestHeaders,
} from "pi-extensions-shared/codex";
import { chatgptAccountIdFromToken } from "pi-extensions-shared/jwt";
import { isRecord } from "pi-extensions-shared/record";
import { parseSseFrame } from "pi-extensions-shared/sse";
import { compactionFrames, MAX_FRAME_BYTES } from "./sse.ts";

type AgentMessage =
	SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

export {
	CODEX_BASE_URL,
	CODEX_RESPONSES_URL,
} from "pi-extensions-shared/codex";
export { isRecord } from "pi-extensions-shared/record";
export { MAX_FRAME_BYTES, MAX_STREAM_BYTES } from "./sse.ts";
export const BETA_FEATURE = "remote_compaction_v2";
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_OPAQUE_ITEM_BYTES = MAX_FRAME_BYTES;
export const MAX_CHECKPOINT_BYTES = MAX_FRAME_BYTES;
// Usage is accounting metadata only; a small bound keeps a misbehaving
// backend from bloating the session file through it.
export const MAX_USAGE_BYTES = 4 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 8192;

export type JsonObject = Record<string, unknown>;

export interface RemoteCheckpoint {
	version: 1;
	provider: "openai-codex";
	api: "openai-codex-responses";
	model: string;
	endpoint: typeof CODEX_RESPONSES_URL;
	authMode: "oauth";
	accountFingerprint: string;
	/** Provider-owned Responses item. It is intentionally not interpreted. */
	item: JsonObject;
	/**
	 * Provider-reported usage of the remote request, when the backend sent it.
	 * Pi does not account for this request, so this is the only record of it.
	 */
	usage?: JsonObject;
}

export interface RemoteDetails {
	remoteCompaction: RemoteCheckpoint;
}

export interface RemoteRequestOptions {
	fetch?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	headers?: Record<string, string>;
	/** Receives the completed response's usage object, when one is present. */
	onUsage?: (usage: JsonObject) => void;
}

function serializedBytes(value: unknown): number | undefined {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string"
			? Buffer.byteLength(serialized)
			: undefined;
	} catch {
		return undefined;
	}
}

export const accountIdFromToken = chatgptAccountIdFromToken;

export function accountFingerprint(accountId: string): string {
	return createHash("sha256").update(accountId).digest("base64url");
}

export function isTrustedModel(model: Model<Api>): boolean {
	if (
		model.provider !== "openai-codex" ||
		model.api !== "openai-codex-responses"
	)
		return false;
	try {
		const url = new URL(model.baseUrl ?? CODEX_BASE_URL);
		return (
			url.origin === "https://chatgpt.com" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			url.pathname.replace(/\/+$/, "") === "/backend-api"
		);
	} catch {
		return false;
	}
}

/** Throws unless the value is an integer inside the supported request range. */
export function validateTimeoutMs(timeoutMs: number): void {
	if (
		!Number.isInteger(timeoutMs) ||
		timeoutMs < MIN_TIMEOUT_MS ||
		timeoutMs > MAX_TIMEOUT_MS
	)
		throw new RangeError(
			`timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`,
		);
}

class PayloadCaptured extends Error {}

/**
 * Uses Pi AI's compatibility stream API: unlike the provider-specific converter
 * export, this public entry point is stable across the supported 0.85/0.87
 * version boundary and forwards fetch/onPayload options. Capture stops in
 * onPayload before transport, so no request payload reaches the network.
 *
 * This relies on streamSimple turning a throw from onPayload into a failed
 * result rather than a network call; tests/contract.test.ts pins that
 * behaviour against the installed Pi.
 */
export async function captureCodexInput(
	model: Model<Api>,
	messages: AgentMessage[],
	apiKey: string,
	options: {
		signal?: AbortSignal;
		systemPrompt?: string;
		tools?: Context["tools"];
		reasoning?: ThinkingLevel;
	} = {},
): Promise<{ input: unknown[]; template: JsonObject }> {
	let captured: JsonObject | undefined;
	const context: Context = {
		messages: convertToLlm(messages),
		...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
		...(options.tools ? { tools: options.tools } : {}),
	};
	const result = streamSimple(
		model as Model<"openai-codex-responses">,
		context,
		{
			apiKey,
			cacheRetention: "none",
			...(options.signal ? { signal: options.signal } : {}),
			...(options.reasoning ? { reasoning: options.reasoning } : {}),
			transport: "sse",
			onPayload(payload) {
				if (!isRecord(payload) || !Array.isArray(payload.input))
					throw new Error("Codex converter produced an invalid payload");
				captured = structuredClone(payload);
				throw new PayloadCaptured();
			},
			fetch: async () => {
				throw new Error("Payload capture attempted network access");
			},
		},
	);
	await result.result();
	if (!captured) throw new Error("Codex payload capture failed");
	const { input, ...template } = captured;
	return { input: input as unknown[], template };
}

function checkpointKey(item: JsonObject): string {
	// The encrypted payload is the checkpoint; the id (when present) only
	// distinguishes otherwise identical items, so key ordering is irrelevant.
	return JSON.stringify([item.id ?? null, item.encrypted_content]);
}

interface CompletedResponse {
	item: JsonObject;
	usage?: JsonObject;
}

async function parseCompleted(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): Promise<CompletedResponse> {
	const checkpoints = new Map<string, JsonObject>();
	const addCheckpoint = (value: unknown): void => {
		if (!isRecord(value) || value.type !== "compaction") return;
		if (!validOpaqueItem(value))
			throw new Error("Remote compaction returned an invalid checkpoint");
		const key = checkpointKey(value);
		if (!checkpoints.has(key)) checkpoints.set(key, value);
	};
	const processFrame = (frame: string): CompletedResponse | undefined => {
		const parsed = parseSseFrame(frame);
		if (!parsed) return undefined;
		let event: unknown;
		try {
			event = JSON.parse(parsed.data);
		} catch {
			throw new Error("Remote compaction returned malformed SSE");
		}
		if (!isRecord(event)) return undefined;
		if (
			event.type === "error" ||
			event.type === "response.failed" ||
			event.type === "response.incomplete"
		)
			throw new Error("Remote compaction failed");
		if (event.type === "response.output_item.done") addCheckpoint(event.item);
		if (event.type !== "response.completed" && event.type !== "response.done")
			return undefined;
		const response = event.response;
		if (
			!isRecord(response) ||
			(response.status !== undefined && response.status !== "completed")
		)
			throw new Error("Remote compaction did not complete successfully");
		if (Array.isArray(response.output))
			for (const item of response.output) addCheckpoint(item);
		if (checkpoints.size !== 1)
			throw new Error("Remote compaction returned conflicting checkpoints");
		const item = structuredClone([...checkpoints.values()][0] as JsonObject);
		const usage = validUsage(response.usage)
			? structuredClone(response.usage)
			: undefined;
		return usage ? { item, usage } : { item };
	};
	for await (const frame of compactionFrames(body, signal)) {
		const completed = processFrame(frame);
		if (completed) {
			signal.throwIfAborted();
			return completed;
		}
	}
	throw new Error(
		"Remote compaction stream ended without a completed response",
	);
}

// Preserve documented benign provider metadata, but reject credentials,
// routing/origin controls, and hop-by-hop/framing headers. This keeps the
// resolver useful for provider-specific feature headers without allowing it
// to redirect or smuggle credentials through the fixed Codex request.
const UNSAFE_HEADER =
	/^(authorization|proxy-authorization|cookie|set-cookie|origin|host|referer|connection|keep-alive|proxy-connection|transfer-encoding|content-length|upgrade|trailer|forwarded|via|x-forwarded-.+|x-real-ip|.*(?:auth|token|api[-_]?key|credential).*)$/i;

// These are always set by the extension itself, so resolver values for them
// are discarded even when the unsafe-name pattern would not catch them.
const FIXED_HEADERS = [
	"authorization",
	"chatgpt-account-id",
	"origin",
	"host",
	"content-type",
	"accept",
	"openai-beta",
	"x-codex-beta-features",
	"originator",
];

export function mergedHeaders(
	resolved: Record<string, string> | undefined,
	auth: { accessToken: string; accountId: string },
): Headers {
	const safeResolved = Object.fromEntries(
		Object.entries(resolved ?? {}).filter(
			([name, value]) =>
				name.length <= MAX_HEADER_NAME_LENGTH &&
				typeof value === "string" &&
				value.length <= MAX_HEADER_VALUE_LENGTH &&
				!UNSAFE_HEADER.test(name),
		),
	);
	if (Object.keys(safeResolved).length > MAX_HEADER_COUNT)
		throw new Error("Too many remote compaction headers");
	const headers = new Headers(safeResolved);
	for (const name of FIXED_HEADERS) headers.delete(name);
	for (const [name, value] of Object.entries({
		...codexRequestHeaders(auth),
		"x-codex-beta-features": BETA_FEATURE,
	}))
		headers.set(name, value);
	return headers;
}

function cancelBody(response: Response): void {
	void response.body?.cancel().catch(() => undefined);
}

export async function requestRemoteCompaction(
	template: JsonObject,
	input: unknown[],
	auth: { accessToken: string; accountId: string },
	options: RemoteRequestOptions = {},
): Promise<JsonObject> {
	const body: JsonObject = {
		...template,
		store: false,
		stream: true,
		input: [...input, { type: "compaction_trigger" }],
	};
	// Remote compaction must see the full supplied prefix, never a server-side
	// continuation that could reintroduce history the caller chose to discard.
	delete body.previous_response_id;
	const encoded = JSON.stringify(body);
	if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES)
		throw new Error("Remote compaction request exceeded its size limit");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	validateTimeoutMs(timeoutMs);
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		AbortSignal.timeout(timeoutMs),
	]);
	signal.throwIfAborted();
	const pendingResponse = Promise.resolve().then(() =>
		(options.fetch ?? globalThis.fetch)(CODEX_RESPONSES_URL, {
			method: "POST",
			redirect: "manual",
			signal,
			headers: mergedHeaders(options.headers, auth),
			body: encoded,
		}),
	);
	// A fetch implementation may ignore the signal and resolve after we have
	// given up; its body must still be released.
	void pendingResponse.then(
		(lateResponse) => {
			if (signal.aborted) cancelBody(lateResponse);
		},
		() => undefined,
	);
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	let response: Response;
	try {
		response = await Promise.race([pendingResponse, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
	if (signal.aborted) {
		cancelBody(response);
		throw signal.reason;
	}
	if (response.status >= 300 && response.status < 400) {
		cancelBody(response);
		throw new Error("Remote compaction refused an unexpected redirect");
	}
	if (!response.ok || !response.body) {
		cancelBody(response);
		throw new Error(`Remote compaction failed (HTTP ${response.status})`);
	}
	const completed = await parseCompleted(response.body, signal);
	signal.throwIfAborted();
	if (completed.usage) options.onUsage?.(completed.usage);
	return completed.item;
}

function validOpaqueItem(value: unknown): value is JsonObject {
	if (
		!isRecord(value) ||
		value.type !== "compaction" ||
		typeof value.encrypted_content !== "string" ||
		value.encrypted_content.length === 0
	)
		return false;
	const bytes = serializedBytes(value);
	return bytes !== undefined && bytes <= MAX_OPAQUE_ITEM_BYTES;
}

function validUsage(value: unknown): value is JsonObject {
	if (!isRecord(value)) return false;
	const bytes = serializedBytes(value);
	return bytes !== undefined && bytes <= MAX_USAGE_BYTES;
}

export function buildCheckpoint(
	model: string,
	fingerprint: string,
	item: JsonObject,
	usage?: JsonObject,
): RemoteCheckpoint {
	return {
		version: 1,
		provider: "openai-codex",
		api: "openai-codex-responses",
		model,
		endpoint: CODEX_RESPONSES_URL,
		authMode: "oauth",
		accountFingerprint: fingerprint,
		item,
		...(usage ? { usage } : {}),
	};
}

export function parseCheckpoint(value: unknown): RemoteCheckpoint | undefined {
	const bytes = serializedBytes(value);
	if (
		bytes === undefined ||
		bytes > MAX_CHECKPOINT_BYTES ||
		!isRecord(value) ||
		value.version !== 1 ||
		value.provider !== "openai-codex" ||
		value.api !== "openai-codex-responses" ||
		value.endpoint !== CODEX_RESPONSES_URL ||
		value.authMode !== "oauth" ||
		typeof value.model !== "string" ||
		typeof value.accountFingerprint !== "string" ||
		!value.model ||
		!value.accountFingerprint ||
		value.model.length > 256 ||
		value.accountFingerprint.length > 256 ||
		!validOpaqueItem(value.item) ||
		// Usage is optional so checkpoints written before it was recorded stay
		// valid, but a present non-object value means the entry is corrupt.
		(value.usage !== undefined && !isRecord(value.usage))
	)
		return undefined;
	// Rebuilt rather than returned as-is, so unknown fields in a stored entry
	// never travel further than this validation.
	return buildCheckpoint(
		value.model,
		value.accountFingerprint,
		value.item,
		value.usage,
	);
}
