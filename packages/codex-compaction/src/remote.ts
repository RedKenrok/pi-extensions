import { createHash } from "node:crypto";
import type { Api, Context, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
	convertToLlm,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

type AgentMessage =
	SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_RESPONSES_URL = `${CODEX_BASE_URL}/codex/responses`;
export const BETA_FEATURE = "remote_compaction_v2";
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_STREAM_BYTES = 8 * 1024 * 1024;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;

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
}

export interface RemoteDetails {
	remoteCompaction: RemoteCheckpoint;
}

export interface RemoteRequestOptions {
	fetch?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function accountIdFromToken(token: string): string | undefined {
	const part = token.split(".")[1];
	if (!part) return undefined;
	try {
		const payload = JSON.parse(
			Buffer.from(part, "base64url").toString("utf8"),
		) as unknown;
		if (!isRecord(payload)) return undefined;
		const auth = payload["https://api.openai.com/auth"];
		if (!isRecord(auth)) return undefined;
		const id = auth.chatgpt_account_id;
		return typeof id === "string" && id.trim() ? id.trim() : undefined;
	} catch {
		return undefined;
	}
}

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

class PayloadCaptured extends Error {}

/** Uses Pi AI's public Codex stream converter, but stops in onPayload before transport. */
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
	const { input, previous_response_id: _previous, ...template } = captured;
	return { input: input as unknown[], template };
}

function combineSignals(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; cleanup(): void } {
	const controller = new AbortController();
	const timeout = setTimeout(
		() =>
			controller.abort(
				new DOMException("Remote compaction timed out", "TimeoutError"),
			),
		timeoutMs,
	);
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

async function parseCompleted(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): Promise<JsonObject> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const checkpoints = new Map<string, JsonObject>();
	let buffer = "";
	let total = 0;
	const addCheckpoint = (value: unknown): void => {
		if (!isRecord(value) || value.type !== "compaction") return;
		if (!validOpaqueItem(value))
			throw new Error("Remote compaction returned an invalid checkpoint");
		checkpoints.set(JSON.stringify(value), value);
	};
	const processFrame = (frame: string): boolean => {
		if (encoder.encode(frame).byteLength > MAX_FRAME_BYTES)
			throw new Error("Remote compaction SSE frame exceeded its size limit");
		const raw = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (!raw || raw === "[DONE]") return false;
		let event: unknown;
		try {
			event = JSON.parse(raw);
		} catch {
			throw new Error("Remote compaction returned malformed SSE");
		}
		if (!isRecord(event)) return false;
		if (
			event.type === "error" ||
			event.type === "response.failed" ||
			event.type === "response.incomplete"
		)
			throw new Error("Remote compaction failed");
		if (event.type === "response.output_item.done") addCheckpoint(event.item);
		if (event.type !== "response.completed" && event.type !== "response.done")
			return false;
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
		return true;
	};
	const onAbort = () => void reader.cancel().catch(() => undefined);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			if (signal.aborted) throw signal.reason;
			const chunk = await reader.read();
			if (chunk.value) {
				total += chunk.value.byteLength;
				if (total > MAX_STREAM_BYTES)
					throw new Error("Remote compaction stream exceeded its size limit");
				buffer += decoder.decode(chunk.value, { stream: !chunk.done });
			}
			if (chunk.done) buffer += decoder.decode();
			let match = /\r?\n\r?\n/.exec(buffer);
			while (match) {
				const frame = buffer.slice(0, match.index);
				buffer = buffer.slice(match.index + match[0].length);
				if (processFrame(frame)) {
					if (signal.aborted) throw signal.reason;
					return structuredClone([...checkpoints.values()][0] as JsonObject);
				}
				match = /\r?\n\r?\n/.exec(buffer);
			}
			if (encoder.encode(buffer).byteLength > MAX_FRAME_BYTES)
				throw new Error("Remote compaction SSE frame exceeded its size limit");
			if (chunk.done) {
				if (buffer.trim() && processFrame(buffer)) {
					if (signal.aborted) throw signal.reason;
					return structuredClone([...checkpoints.values()][0] as JsonObject);
				}
				throw new Error(
					"Remote compaction stream ended without a completed response",
				);
			}
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export async function requestRemoteCompaction(
	template: JsonObject,
	input: unknown[],
	auth: { accessToken: string; accountId: string },
	options: RemoteRequestOptions = {},
): Promise<JsonObject> {
	const body: JsonObject = {
		...template,
		model: template.model,
		store: false,
		stream: true,
		input: [...input, { type: "compaction_trigger" }],
	};
	delete body.previous_response_id;
	const encoded = JSON.stringify(body);
	if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES)
		throw new Error("Remote compaction request exceeded its size limit");
	const combined = combineSignals(
		options.signal,
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	try {
		const response = await (options.fetch ?? globalThis.fetch)(
			CODEX_RESPONSES_URL,
			{
				method: "POST",
				redirect: "manual",
				signal: combined.signal,
				headers: {
					Accept: "text/event-stream",
					Authorization: `Bearer ${auth.accessToken}`,
					"ChatGPT-Account-ID": auth.accountId,
					"Content-Type": "application/json",
					"OpenAI-Beta": "responses=experimental",
					"x-codex-beta-features": BETA_FEATURE,
					originator: "pi",
				},
				body: encoded,
			},
		);
		if (response.status >= 300 && response.status < 400)
			throw new Error("Remote compaction refused an unexpected redirect");
		if (!response.ok || !response.body)
			throw new Error(`Remote compaction failed (HTTP ${response.status})`);
		const checkpoint = await parseCompleted(response.body, combined.signal);
		if (combined.signal.aborted) throw combined.signal.reason;
		return checkpoint;
	} finally {
		combined.cleanup();
	}
}

function validOpaqueItem(value: unknown): value is JsonObject {
	return (
		isRecord(value) &&
		value.type === "compaction" &&
		typeof value.encrypted_content === "string" &&
		value.encrypted_content.length > 0 &&
		Buffer.byteLength(value.encrypted_content) <= MAX_STREAM_BYTES
	);
}

export function parseCheckpoint(value: unknown): RemoteCheckpoint | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		value.provider !== "openai-codex" ||
		value.api !== "openai-codex-responses" ||
		value.endpoint !== CODEX_RESPONSES_URL ||
		value.authMode !== "oauth" ||
		typeof value.model !== "string" ||
		typeof value.accountFingerprint !== "string" ||
		!validOpaqueItem(value.item)
	)
		return undefined;
	return value as unknown as RemoteCheckpoint;
}
