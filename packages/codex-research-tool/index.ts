import { AsyncLocalStorage } from "node:async_hooks";
import {
	type ExtensionAPI,
	type ExtensionContext,
	readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import { AuthAdapter, type AuthUnavailableReason } from "./src/auth.ts";
import {
	CODEX_CLIENT_VERSION,
	CodexClient,
	type ResearchBackend,
} from "./src/codex.ts";
import {
	AVAILABILITY_MESSAGES,
	ResearchError,
	type ResearchErrorCode,
} from "./src/errors.ts";
import {
	initialLifecycleState,
	type LifecycleEffect,
	type LifecycleEvent,
	statusText,
	transition,
} from "./src/lifecycle.ts";
import { AVAILABILITY_TIMEOUT_MS } from "./src/limits.ts";
import { createResearchTool, TOOL_NAME } from "./src/search.ts";
import { diagnose } from "./src/util.ts";

// These reasons mean the stored login itself is unusable, so the cached
// verification must not outlive them.
const CREDENTIAL_FAILURES: ReadonlySet<AuthUnavailableReason> = new Set([
	"missing_oauth",
	"refresh_failed",
	"missing_account_id",
]);

/** The Pi extension API members this extension uses. */
export type ResearchHost = Pick<
	ExtensionAPI,
	| "on"
	| "registerCommand"
	| "registerTool"
	| "getActiveTools"
	| "setActiveTools"
>;

export interface ResearchExtensionDependencies {
	codexClientVersion?: string;
	readCredential?: typeof readStoredCredential;
	resolveAccessToken?: (
		ctx: ExtensionContext | undefined,
		signal?: AbortSignal,
	) => Promise<string | undefined>;
	client?: ResearchBackend;
}

export function createResearchExtension(
	dependencies: ResearchExtensionDependencies = {},
): (pi: ResearchHost) => void {
	return (pi: ResearchHost): void => {
		let state = initialLifecycleState;
		let lastContext: ExtensionContext | undefined;
		let activeCheck: AbortController | undefined;
		const runtimeController = new AbortController();
		// Tool calls remember the generation they started in, so a late failure
		// from a call made before a refresh cannot disable the refreshed tool.
		const executionGeneration = new AsyncLocalStorage<number>();
		const client =
			dependencies.client ??
			new CodexClient({
				clientVersion: dependencies.codexClientVersion ?? CODEX_CLIENT_VERSION,
			});
		const auth = new AuthAdapter({
			readCredential: () =>
				(dependencies.readCredential ?? readStoredCredential)("openai-codex"),
			resolveAccessToken: (signal) =>
				dependencies.resolveAccessToken
					? dependencies.resolveAccessToken(lastContext, signal)
					: lastContext
						? lastContext.modelRegistry.getApiKeyForProvider("openai-codex")
						: Promise.resolve(undefined),
		});

		const notice = (message: string, level: "info" | "warning"): void => {
			const ctx = lastContext;
			if (ctx?.mode === "tui") ctx.ui.notify(message, level);
			else console.error(message);
		};

		const setActive = (enabled: boolean): void => {
			const active = pi.getActiveTools();
			if (enabled && !active.includes(TOOL_NAME)) {
				pi.setActiveTools([...active, TOOL_NAME]);
			} else if (!enabled && active.includes(TOOL_NAME)) {
				pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
			}
		};

		const register = (): void => {
			const tool = createResearchTool({
				authCheck: (signal) =>
					auth.check({
						...(signal ? { signal } : {}),
						timeoutMs: AVAILABILITY_TIMEOUT_MS,
					}),
				client,
				runtimeSignal: runtimeController.signal,
				onUnavailable(reason, code) {
					const errorCode: ResearchErrorCode = code ?? "backend_incompatible";
					diagnose(`tool:unavailable:${errorCode}`);
					void dispatch({
						type: "tool_unavailable",
						generation:
							executionGeneration.getStore() ?? state.registeredGeneration,
						message: AVAILABILITY_MESSAGES[errorCode],
						block: reason === "backend" && errorCode !== "auth_required",
						invalidateAuth:
							reason === "credentials" || errorCode === "auth_required",
					});
				},
			});
			const execute = tool.execute;
			pi.registerTool({
				...tool,
				execute: (...args) =>
					executionGeneration.run(state.registeredGeneration, () =>
						execute(...args),
					),
			});
		};

		// Returns the started check, if any, so callers can await its outcome.
		const perform = (effect: LifecycleEffect): Promise<void> | undefined => {
			switch (effect.type) {
				case "register":
					register();
					return;
				case "enable":
					setActive(true);
					return;
				case "disable":
					setActive(false);
					return;
				case "notify":
					notice(effect.message, effect.level);
					return;
				case "invalidate_auth":
					auth.invalidate();
					return;
				case "invalidate_catalog":
					client.invalidateModel();
					return;
				case "abort_check":
					activeCheck?.abort(
						new DOMException(
							"Research availability check superseded",
							"AbortError",
						),
					);
					activeCheck = undefined;
					return;
				case "run_check":
					return runCheck(effect.token, effect.generation, effect.explicit);
			}
		};

		const dispatch = async (event: LifecycleEvent): Promise<void> => {
			const result = transition(state, event);
			state = result.state;
			const started = result.effects.map(perform);
			await Promise.all(started);
		};

		const runCheck = (
			token: number,
			generation: number,
			explicit: boolean,
		): Promise<void> => {
			const controller = new AbortController();
			activeCheck = controller;
			const signal = AbortSignal.any([
				controller.signal,
				AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
				runtimeController.signal,
			]);
			const isCurrent = () =>
				!state.shutDown &&
				state.checkToken === token &&
				state.generation === generation;
			const unavailable = (
				message: string,
				reasonCode: string,
				options: { block: boolean; invalidateAuth: boolean },
			) => {
				if (isCurrent()) diagnose(`availability:${reasonCode}`);
				void dispatch({
					type: "check_unavailable",
					token,
					generation,
					message,
					...options,
				});
			};
			// Superseded and shutdown checks are discarded by the reducer, so an
			// aborted signal that reaches a dispatch here means the check timed out.
			const timedOut = () =>
				unavailable(AVAILABILITY_MESSAGES.timeout, "timeout", {
					block: true,
					invalidateAuth: false,
				});
			return (async () => {
				const result = await auth.check({
					signal,
					timeoutMs: AVAILABILITY_TIMEOUT_MS,
				});
				if (signal.aborted) return timedOut();
				if (result.kind !== "ready") {
					return unavailable(result.message, result.reason, {
						block: false,
						invalidateAuth: CREDENTIAL_FAILURES.has(result.reason),
					});
				}
				try {
					await client.selectModel(result, signal);
				} catch (cause) {
					if (signal.aborted) return timedOut();
					const code =
						cause instanceof ResearchError
							? cause.code
							: "backend_incompatible";
					return unavailable(AVAILABILITY_MESSAGES[code], code, {
						block: true,
						invalidateAuth: code === "auth_required",
					});
				}
				if (signal.aborted) return timedOut();
				if (isCurrent()) diagnose("availability:ready");
				void dispatch({ type: "check_ready", token, generation, explicit });
			})().finally(() => {
				if (activeCheck === controller) activeCheck = undefined;
			});
		};

		const checkAvailability = (
			ctx: ExtensionContext,
			explicit: boolean,
		): Promise<void> => {
			lastContext = ctx;
			return dispatch({ type: "check_start", explicit });
		};

		pi.registerCommand("research", {
			description: "Show or refresh Codex research availability",
			handler: async (args, ctx) => {
				lastContext = ctx;
				const command = args.trim().toLowerCase();
				if (!command || command === "status") {
					ctx.ui.notify(statusText(state.availability, state.blocked), "info");
					return;
				}
				if (command === "refresh") {
					await checkAvailability(ctx, true);
					return;
				}
				ctx.ui.notify("Usage: /research [status|refresh]", "warning");
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			lastContext = ctx;
			await dispatch({ type: "session_start" });
			await checkAvailability(ctx, false);
		});

		pi.on("before_agent_start", async (_event, ctx) => {
			await checkAvailability(ctx, false);
		});

		pi.on("session_shutdown", () => {
			void dispatch({ type: "shutdown" });
			runtimeController.abort(
				new DOMException("Pi session ended", "AbortError"),
			);
			auth.dispose();
		});
	};
}

export default createResearchExtension();
