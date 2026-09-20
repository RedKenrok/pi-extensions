import {
	type ExtensionAPI,
	type ExtensionContext,
	readStoredCredential,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { AuthAdapter, unsupportedPiResult } from "./src/auth.ts";
import {
	CODEX_CLIENT_VERSION,
	CodexClient,
	ResearchError,
	type ResearchErrorCode,
} from "./src/codex.ts";
import { createResearchTool, TOOL_NAME } from "./src/search.ts";

type Availability =
	| { kind: "unchecked" }
	| { kind: "ready" }
	| { kind: "unavailable"; message: string };

function supportsPi(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const [, major, minor, patch = 0] = match.map(Number);
	return major === 0 && minor === 85 && patch >= 1;
}

function removeResearch(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	if (active.includes(TOOL_NAME)) {
		pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	}
}

function enableResearch(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	if (!active.includes(TOOL_NAME)) {
		pi.setActiveTools([...active, TOOL_NAME]);
	}
}

function statusText(
	availability: Availability,
	blockedUntilRefresh: boolean,
): string {
	if (blockedUntilRefresh && availability.kind === "unavailable") {
		return `Research: ${availability.message}`;
	}
	if (blockedUntilRefresh) {
		return "Research: unavailable after a backend authentication, access, or compatibility failure. Run /research refresh after resolving it.";
	}
	if (availability.kind === "ready") {
		return "Research: Ready (Pi Codex subscription); credentials and backend model access are verified.";
	}
	if (availability.kind === "unavailable") {
		return `Research: ${availability.message}`;
	}
	return "Research: authentication has not been checked yet.";
}

export interface ResearchExtensionDependencies {
	piVersion?: string;
	codexClientVersion?: string;
	/** @deprecated Use piVersion. */
	version?: string;
	readCredential?: typeof readStoredCredential;
	resolveAccessToken?: (
		ctx: ExtensionContext | undefined,
		signal?: AbortSignal,
	) => Promise<string | undefined>;
	client?: CodexClient;
}

export function createResearchExtension(
	dependencies: ResearchExtensionDependencies = {},
): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI): void => {
		const piVersion = dependencies.piVersion ?? dependencies.version ?? VERSION;
		let generation = 0;
		let registered = false;
		let availability: Availability = { kind: "unchecked" };
		let blockedUntilRefresh = false;
		let disabledByExtension = false;
		let lastNotice: string | undefined;
		let lastContext: ExtensionContext | undefined;
		const runtimeController = new AbortController();
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

		const notice = (
			ctx: ExtensionContext,
			message: string,
			type: "info" | "warning" | "error" = "warning",
		): void => {
			if (lastNotice === message) return;
			lastNotice = message;
			if (ctx.mode === "tui") {
				ctx.ui.notify(message, type);
			} else {
				console.error(message);
			}
		};

		const deactivate = (
			ctx: ExtensionContext,
			message: string,
			block: boolean,
		): void => {
			if (registered) removeResearch(pi);
			disabledByExtension = true;
			if (block) blockedUntilRefresh = true;
			notice(ctx, message, "warning");
		};

		const backendMessage = (code: ResearchErrorCode): string => {
			if (code === "access_denied") {
				return "Research access was denied for this account. Run /research refresh after access is restored.";
			}
			if (code === "client_outdated") {
				return "Research is unavailable because the Codex compatibility version may be outdated. Update codex-research-tool, then run /research refresh.";
			}
			if (code === "auth_required") {
				return "Research needs you to sign in again. Run /login openai-codex, then /research refresh.";
			}
			if (code === "rate_limited") {
				return "Research availability is rate limited. Run /research refresh after the cooldown.";
			}
			if (code === "network" || code === "timeout" || code === "cancelled") {
				return "Research could not verify Codex backend availability. Check the connection, then run /research refresh.";
			}
			return "Research is incompatible with the current Codex backend. Update codex-research-tool or Pi, then run /research refresh.";
		};

		const registerOnce = (ctx: ExtensionContext): void => {
			if (registered) return;
			pi.registerTool(
				createResearchTool({
					authCheck: (signal) =>
						auth.check({ ...(signal ? { signal } : {}), timeoutMs: 5_000 }),
					client,
					runtimeSignal: runtimeController.signal,
					onUnavailable(reason, code) {
						const current = lastContext ?? ctx;
						const message = backendMessage(code ?? "backend_incompatible");
						availability = {
							kind: "unavailable",
							message,
						};
						deactivate(current, message, reason === "backend");
					},
				}),
			);
			registered = true;
			enableResearch(pi);
			disabledByExtension = false;
		};

		const checkAvailability = async (
			ctx: ExtensionContext,
			explicit: boolean,
		): Promise<void> => {
			lastContext = ctx;
			const checkGeneration = generation;
			if (blockedUntilRefresh && !explicit) {
				if (registered) removeResearch(pi);
				return;
			}
			if (explicit) {
				blockedUntilRefresh = false;
				lastNotice = undefined;
				client.invalidateModel();
			}
			const availabilityController = new AbortController();
			const timeout = setTimeout(
				() =>
					availabilityController.abort(
						new DOMException(
							"Research availability check timed out",
							"TimeoutError",
						),
					),
				5_000,
			);
			const onRuntimeAbort = () =>
				availabilityController.abort(runtimeController.signal.reason);
			runtimeController.signal.addEventListener("abort", onRuntimeAbort, {
				once: true,
			});
			if (runtimeController.signal.aborted) onRuntimeAbort();
			try {
				const result = supportsPi(piVersion)
					? await auth.check({
							signal: availabilityController.signal,
							timeoutMs: 5_000,
						})
					: unsupportedPiResult();
				if (checkGeneration !== generation || runtimeController.signal.aborted)
					return;
				if (result.kind === "ready") {
					try {
						await client.selectModel(result, availabilityController.signal);
					} catch (cause) {
						const error =
							cause instanceof ResearchError
								? cause
								: new ResearchError(
										"backend_incompatible",
										"Research could not verify Codex backend compatibility.",
										false,
									);
						const message = backendMessage(error.code);
						availability = { kind: "unavailable", message };
						deactivate(ctx, message, true);
						return;
					}
					availability = { kind: "ready" };
					if (!registered) {
						registerOnce(ctx);
					} else if (explicit) {
						enableResearch(pi);
						disabledByExtension = false;
					} else if (disabledByExtension) {
						enableResearch(pi);
						disabledByExtension = false;
					}
					if (explicit) notice(ctx, statusText(availability, false), "info");
					return;
				}
				availability = { kind: "unavailable", message: result.message };
				if (registered) removeResearch(pi);
				notice(ctx, result.message, "warning");
			} finally {
				clearTimeout(timeout);
				runtimeController.signal.removeEventListener("abort", onRuntimeAbort);
			}
		};

		pi.registerCommand("research", {
			description: "Show or refresh Codex research availability",
			handler: async (args, ctx) => {
				lastContext = ctx;
				const command = args.trim().toLowerCase();
				if (!command || command === "status") {
					ctx.ui.notify(statusText(availability, blockedUntilRefresh), "info");
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
			generation += 1;
			lastContext = ctx;
			blockedUntilRefresh = false;
			await checkAvailability(ctx, false);
		});

		pi.on("before_agent_start", async (_event, ctx) => {
			lastContext = ctx;
			await checkAvailability(ctx, false);
		});

		pi.on("session_shutdown", () => {
			generation += 1;
			runtimeController.abort(
				new DOMException("Pi session ended", "AbortError"),
			);
			auth.dispose();
		});
	};
}

export default createResearchExtension();
export { supportsPi };
