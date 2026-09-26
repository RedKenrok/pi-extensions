import type { Model } from "@earendil-works/pi-ai";
import type {
	BeforeProviderRequestEvent,
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { partialFake } from "../../../test-support/fakes.ts";
import { jwt } from "../../../test-support/jwt.ts";

export type RemoteDetails = {
	fallbackReason?: string;
	remoteCompaction?: {
		item: { encrypted_content: string };
		usage?: Record<string, unknown>;
	};
};
export type CompactResult = {
	cancel?: boolean;
	compaction?: CompactionResult<RemoteDetails>;
};
export type CompactHandler = ExtensionHandler<
	SessionBeforeCompactEvent,
	CompactResult
>;
export type ReplayHandler = ExtensionHandler<
	BeforeProviderRequestEvent,
	unknown
>;

export const model = {
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
} satisfies Model<"openai-codex-responses">;

export const CODEX_BASE = "https://chatgpt.com/backend-api";

type ApiMembers = Pick<
	ExtensionAPI,
	"getActiveTools" | "getAllTools" | "registerTool" | "registerCommand"
>;

/**
 * Only the members the extension touches are implemented; partialFake checks
 * each of them against Pi's own types.
 */
export function fakePi(members: Partial<ApiMembers> = {}) {
	const handlers = new Map<string, unknown>();
	const events: string[] = [];
	const api = partialFake<ExtensionAPI>({
		on(name: string, handler: unknown) {
			events.push(name);
			handlers.set(name, handler);
			// Pi 0.87 returns an unsubscribe function from on(); 0.85 returns void,
			// which a function-returning fake also satisfies.
			return () => {
				if (handlers.get(name) === handler) handlers.delete(name);
			};
		},
		getActiveTools: () => [],
		getAllTools: () => [],
		...members,
	});
	return {
		api,
		events,
		compactHandler(): CompactHandler {
			const handler = handlers.get("session_before_compact");
			if (!handler) throw new Error("session_before_compact not registered");
			return handler as CompactHandler;
		},
		replayHandler(): ReplayHandler {
			const handler = handlers.get("before_provider_request");
			if (!handler) throw new Error("before_provider_request not registered");
			return handler as ReplayHandler;
		},
	};
}

type Registry = ExtensionContext["modelRegistry"];
export interface FakeContextParts {
	model?: ExtensionContext["model"];
	thinkingLevel?: ExtensionContext["thinkingLevel"];
	getSystemPrompt?: () => string;
	isUsingOAuth?: () => boolean;
	getApiKeyAndHeaders?: () => Promise<
		Awaited<ReturnType<Registry["getApiKeyAndHeaders"]>>
	>;
	// Replay tests deliberately feed malformed entries, so branches are built
	// from plain objects rather than well-formed SessionEntry values.
	getBranch?: () => unknown[];
}

export function fakeContext(parts: FakeContextParts = {}): ExtensionContext {
	return partialFake<ExtensionContext>({
		model: "model" in parts ? parts.model : model,
		thinkingLevel: parts.thinkingLevel ?? "low",
		getSystemPrompt: parts.getSystemPrompt ?? (() => "system"),
		modelRegistry: {
			isUsingOAuth: parts.isUsingOAuth ?? (() => true),
			getApiKeyAndHeaders:
				parts.getApiKeyAndHeaders ??
				(async () => ({ ok: true, apiKey: jwt("acct"), baseUrl: CODEX_BASE })),
		},
		sessionManager: {
			getBranch: (parts.getBranch ?? (() => [])) as () => SessionEntry[],
		},
	});
}
