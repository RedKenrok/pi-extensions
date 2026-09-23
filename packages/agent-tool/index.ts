// biome-ignore-all lint/suspicious/noExplicitAny: IPC responses are validated by the supervisor action contract and vary by action.
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	agentParameters,
	errorResult,
	result,
	validateAction,
} from "./src/contract.ts";
import { ensureSupervisor, ipcCall } from "./src/ipc.ts";
import type {
	AdmissionStatus,
	AgentAction,
	ParentIdentity,
	ToolRequest,
	UsageReport,
} from "./src/types.ts";

type Connection = Awaited<ReturnType<typeof ensureSupervisor>>;
type ResolvedAgent = {
	agentId: string;
	runId?: string;
	state: string;
	summary: string;
	outputTruncated?: boolean;
	usage?: UsageReport;
};
type AgentStateDetails = {
	agentId: string;
	state: string;
	reason?: string;
	resultSummary?: string;
	error?: { code?: string; message?: string };
};
type SpawnDetails = {
	agentId: string;
	runId: string;
	state: string;
	reason?: string;
	error?: { message?: string };
	effective: {
		model: { provider: string; id: string };
		reasoning: string;
		cwd: string;
		limits?: { runtimeSeconds?: number };
	};
	admission?: AdmissionStatus;
};
type CatalogDetails = {
	models: Array<{
		provider: string;
		id: string;
		name?: string;
		reasoning: string[];
		configuredReasoning?: string;
		scopeId: string;
	}>;
	scopes: Array<{
		scopeId: string;
		provider: string;
		admission: AdmissionStatus;
	}>;
	profiles: unknown[];
	selection: "scoped" | "all";
	nextCursor?: string;
};
type Notification = {
	eventId: number;
	agentId: string;
	payload: {
		kind?: "agent_resolved" | "idle_resolved";
		runId?: string;
		status?: string;
		summary?: string;
		outputTruncated?: boolean;
		idleId?: string;
		resolution?: string;
		triggerTurn?: boolean;
		disconnectPolicy?: string;
		agents?: ResolvedAgent[];
		usage?: UsageReport;
	};
};

function usageLine(
	report: UsageReport | undefined,
	lifetime = false,
): string | undefined {
	if (!report) return undefined;
	const value = lifetime ? report.lifetime : report.currentRun;
	if (!value) return undefined;
	const cost =
		value.cost === null ? "cost unknown" : `cost $${value.cost.toFixed(4)}`;
	const cacheWrite = value.cacheWrite
		? `, ${value.cacheWrite.toLocaleString()} cache write`
		: "";
	return `${value.totalTokens.toLocaleString()} tokens (${value.input.toLocaleString()} in, ${value.output.toLocaleString()} out, ${value.cacheRead.toLocaleString()} cache read${cacheWrite}; ${cost})`;
}

function agentStateLine(agent: AgentStateDetails): string {
	const error = agent.error?.message
		? `${agent.error.code ?? agent.reason ?? "error"}: ${agent.error.message}`
		: undefined;
	const reason = agent.resultSummary ?? error ?? agent.reason;
	return `${agent.agentId}:${agent.state}${reason ? ` (${reason})` : ""}`;
}

export function spawnContent(details: SpawnDetails): string {
	const model = `${details.effective.model.provider}/${details.effective.model.id}`;
	const runtime = details.effective.limits?.runtimeSeconds
		? ` Runtime limit: ${details.effective.limits.runtimeSeconds} seconds.`
		: "";
	if (details.state === "blocked") {
		return `Accepted agent ${details.agentId} (${details.runId}) as blocked: ${details.admission?.message ?? details.error?.message ?? details.reason ?? "provider unavailable"} Model ${model}, reasoning ${details.effective.reasoning}, workspace ${details.effective.cwd}.${runtime}`;
	}
	return `Accepted ${details.agentId} (${details.runId}) in ${details.state}. Continue independent work or end your turn without polling; completion will be delivered automatically and resume this parent when it is idle. Use idle only to join a specific group under a completion condition, and use stop only to cancel unwanted work. Model ${model}, reasoning ${details.effective.reasoning}, workspace ${details.effective.cwd}.${runtime}`;
}

export function catalogContent(details: CatalogDetails): string {
	const manual = details.scopes.filter(
		(scope) => scope.admission.status === "manual_retry_required",
	).length;
	const cooling = details.scopes.filter(
		(scope) => scope.admission.status === "cooling_down",
	).length;
	const availability =
		manual > 0 || cooling > 0
			? `\nScheduler admission blocks: ${manual} manual-retry, ${cooling} cooling-down provider scope(s). Inspect scope admission details before spawning.`
			: "";
	const selection =
		details.selection === "scoped"
			? "the session-scoped model selection"
			: "all authenticated models because no session scope is configured";
	const models = details.models
		.map((model) => {
			const configured = model.configuredReasoning
				? `; selected effort: ${model.configuredReasoning}`
				: "";
			return `- ${model.provider}/${model.id}; supported efforts: ${model.reasoning.join(", ") || "off"}${configured}`;
		})
		.join("\n");
	const pagination = details.nextCursor
		? ` More models are available; call catalog with cursor ${details.nextCursor}.`
		: "";
	return `${details.models.length} model(s) from ${selection}; ${details.profiles.length} profile(s).\n${models || "- No usable models in this selection."}${availability}${pagination}`;
}

export function notificationContent(notification: Notification): string {
	const payload = notification.payload;
	if (payload.kind === "idle_resolved" && payload.idleId && payload.agents) {
		const agents = payload.agents
			.map(
				(agent) =>
					`- ${agent.agentId} ${agent.state}: ${agent.summary}${usageLine(agent.usage) ? `\n  Usage: ${usageLine(agent.usage)}` : ""}`,
			)
			.join("\n");
		const inspect = payload.agents.some((agent) => agent.outputTruncated)
			? "\n\nThe final result excerpts above are bounded, and one or more were truncated. Full child output and transcripts are intentionally unavailable to the parent. If necessary, resume a completed agent and ask it for a concise restatement."
			: "";
		return `Agent group ${payload.idleId} has resolved (${payload.resolution ?? "all_settled"}).\n${agents}${inspect}`;
	}
	const status = payload.status ?? "updated";
	const disposition = ["completed", "failed", "stopped"].includes(status)
		? "has resolved"
		: "requires attention";
	const usage = usageLine(payload.usage);
	const inspect = payload.outputTruncated
		? `\n\nThe final result excerpt above was truncated at the bounded delivery limit. Full child output and transcripts are intentionally unavailable to the parent. If necessary, resume agent ${notification.agentId} and ask it for a concise restatement.`
		: status !== "completed"
			? `\n\nInspect agent ${notification.agentId} for state and diagnostics.`
			: "";
	return `Agent ${notification.agentId} ${disposition} as ${status}: ${payload.summary ?? "Inspect the agent for details."}${usage ? `\nRun usage: ${usage}` : ""}${inspect}`;
}

export function idleResult(details: {
	idleId: string;
	state: "armed" | "resolved";
	resolution?: string;
	agents: ResolvedAgent[];
}) {
	const inspect = details.agents.some((agent) => agent.outputTruncated)
		? " One or more final result excerpts were truncated at the bounded delivery limit; full child output and transcripts are intentionally unavailable to the parent. Resume a completed agent and request a concise restatement if needed."
		: "";
	return result(
		details.state === "armed"
			? `Idle barrier ${details.idleId} is armed for ${details.agents.map((agent) => agent.agentId).join(", ")}. This parent run will settle now and resume automatically when the group resolves.`
			: `Idle barrier ${details.idleId} resolved immediately (${details.resolution}). ${details.agents.map((agent) => `${agent.agentId}:${agent.state} (${agent.summary})`).join(", ")}.${inspect}`,
		details,
		details.state === "armed",
	);
}

export default function piTools(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let connection: Promise<Connection> | undefined;
	let bridgeTimer: NodeJS.Timeout | undefined;
	let bridgeGeneration = 0;
	let bridgeFailures = 0;
	let activeParent: ParentIdentity | undefined;
	let activeContext: ExtensionContext | undefined;
	let parentBusy = false;
	let draining = false;
	const connect = () =>
		(connection ??= ensureSupervisor(agentDir).catch((error) => {
			connection = undefined;
			throw error;
		}));
	const identity = (ctx: ExtensionContext): ParentIdentity => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		const branchAnchor = ctx.sessionManager.getLeafId();
		return {
			sessionId: ctx.sessionManager.getSessionId(),
			...(sessionFile ? { sessionFile } : {}),
			...(branchAnchor ? { branchAnchor } : {}),
		};
	};
	const makeRequest = (
		ctx: ExtensionContext,
		toolCallId: string,
		action: AgentAction,
	): ToolRequest => {
		const hostTools = pi.getActiveTools();
		const activeTools = new Set(hostTools);
		return {
			requestId:
				action.action === "spawn" && action.requestId
					? action.requestId
					: toolCallId,
			toolCallId,
			parent: identity(ctx),
			...(ctx.model
				? { parentModel: { provider: ctx.model.provider, id: ctx.model.id } }
				: {}),
			...(ctx.thinkingLevel ? { parentReasoning: ctx.thinkingLevel } : {}),
			...(ctx.scopedModels.length
				? {
						parentScopedModels: ctx.scopedModels.map(
							({ model, thinkingLevel }) => ({
								model: { provider: model.provider, id: model.id },
								...(thinkingLevel ? { thinkingLevel } : {}),
							}),
						),
					}
				: {}),
			cwd: ctx.cwd,
			trustedProject: ctx.isProjectTrusted(),
			hostTools,
			hostToolSources: pi
				.getAllTools()
				.filter(
					(tool) =>
						tool.name !== "agent" &&
						activeTools.has(tool.name) &&
						!tool.sourceInfo.path.startsWith("<"),
				)
				.map((tool) => ({ name: tool.name, path: tool.sourceInfo.path })),
			action,
		};
	};
	const invoke = async (
		ctx: ExtensionContext,
		toolCallId: string,
		action: AgentAction,
	) => {
		validateAction(action);
		const target = await connect();
		return await ipcCall(
			target.socketPath,
			target.token,
			"tool",
			makeRequest(ctx, toolCallId, action),
			(action.action === "wait" ? (action.timeoutMs ?? 60_000) : 10_000) + 5000,
		);
	};
	const parentIsBusy = () => parentBusy || activeContext?.isIdle() === false;
	const drain = async (parent: ParentIdentity) => {
		if (draining || parentIsBusy()) return;
		draining = true;
		try {
			const target = await connect();
			const response = (await ipcCall(
				target.socketPath,
				target.token,
				"drain_outbox",
				{ parentSessionId: parent.sessionId },
			)) as { notifications: Notification[] };
			if (
				!response.notifications.length ||
				parentIsBusy() ||
				activeParent?.sessionId !== parent.sessionId
			)
				return;
			const ids: number[] = [];
			for (const notification of response.notifications) {
				if (parentIsBusy()) break;
				pi.sendMessage(
					{
						customType: "pi-tools-agent-result",
						content: notificationContent(notification),
						display: true,
						details: notification,
					},
					{
						deliverAs: "followUp",
						triggerTurn: notification.payload.triggerTurn !== false,
					},
				);
				ids.push(notification.eventId);
			}
			await ipcCall(target.socketPath, target.token, "ack_outbox", {
				parentSessionId: parent.sessionId,
				eventIds: ids,
			});
		} finally {
			draining = false;
		}
	};
	const scheduleDrain = (generation: number, delayMs = 1000): void => {
		bridgeTimer = setTimeout(async () => {
			const parent = activeParent;
			if (!parent || generation !== bridgeGeneration) return;
			try {
				await drain(parent);
				if (bridgeFailures > 0)
					console.error("Durable agent notification bridge recovered");
				bridgeFailures = 0;
			} catch (error) {
				bridgeFailures += 1;
				if (bridgeFailures === 1)
					console.error(
						"Durable agent notification bridge failed; retrying with backoff",
						error,
					);
			}
			if (generation === bridgeGeneration && activeParent) {
				const nextDelay =
					bridgeFailures === 0
						? 1000
						: Math.min(30_000, 1000 * 2 ** Math.min(bridgeFailures, 5));
				scheduleDrain(generation, nextDelay);
			}
		}, delayMs);
		bridgeTimer.unref();
	};

	pi.on("session_start", async (_event, ctx) => {
		const parent = identity(ctx);
		activeParent = parent;
		activeContext = ctx;
		parentBusy = !ctx.isIdle();
		bridgeGeneration += 1;
		bridgeFailures = 0;
		const generation = bridgeGeneration;
		const target = await connect();
		await ipcCall(target.socketPath, target.token, "parent_attach", {
			parentSessionId: parent.sessionId,
			branchAnchor: parent.branchAnchor,
		});
		if (
			generation !== bridgeGeneration ||
			activeParent?.sessionId !== parent.sessionId
		)
			return;
		await drain(parent).catch((error) => {
			bridgeFailures = 1;
			console.error(
				"Durable agent notification bridge failed; retrying with backoff",
				error,
			);
		});
		if (
			generation !== bridgeGeneration ||
			activeParent?.sessionId !== parent.sessionId
		)
			return;
		if (bridgeTimer) clearTimeout(bridgeTimer);
		scheduleDrain(generation, bridgeFailures === 0 ? 1000 : 2000);
	});
	pi.on("agent_start", () => {
		parentBusy = true;
	});
	pi.on("agent_settled", () => {
		parentBusy = false;
	});
	pi.on("input", async (_event, ctx) => {
		const parent = identity(ctx);
		const target = await connect();
		await ipcCall(target.socketPath, target.token, "parent_input", {
			parentSessionId: parent.sessionId,
		});
	});
	pi.on("session_shutdown", async (event) => {
		const parent = activeParent;
		activeParent = undefined;
		activeContext = undefined;
		parentBusy = false;
		bridgeGeneration += 1;
		if (bridgeTimer) clearTimeout(bridgeTimer);
		bridgeTimer = undefined;
		if (parent)
			try {
				const target = await connect();
				await ipcCall(target.socketPath, target.token, "parent_detach", {
					parentSessionId: parent.sessionId,
					reason: event.reason,
				});
			} catch {
				/* supervisor will retain pending work when its state remains valid */
			}
	});

	pi.registerTool({
		name: "agent",
		label: "Durable agent",
		description: "Run and manage background agents.",
		promptSnippet: "Run or manage background agents",
		promptGuidelines: [
			"Agent spawn returns immediately. Continue independent work or end the parent turn without polling; completion notifications automatically resume the parent when it is idle.",
			"Before the first spawn in a session, call agent catalog at least once. It lists the user's session-scoped models, or all authenticated models when no scope is configured.",
			"Agent spawn requires an exact catalog model {provider, id}; models are not inherited. Use only a reasoning effort listed for that model.",
			"Agents have a one-hour wall-clock runtime by default. The only spawn limit is limits.runtimeSeconds, specified as a positive integer number of seconds; there are no turn or token limits.",
			"If catalog returns nextCursor and the desired model is not shown, call catalog again with that cursor before spawning.",
			"By default, spawned agents receive only the parent's active read, grep, find, and ls tools; pass tools explicitly when more access is required.",
			"Check catalog admission before spawning. If blocked, do not duplicate that provider scope; resume one existing blocked agent when availability returns.",
			"After the parent resumes from a quota interruption, call list once. Child processes exit but quota-affected agents normally remain blocked with saved conversations: resume one existing blocked agent per provider scope, and a successful probe releases siblings configured for when_available recovery. Agents whose state is literally stopped are terminal and must be replaced.",
			"Do not call agent idle for ordinary completion delivery. Use idle only as the final action when joining a specific group under all-settled, first-result, quorum, fail-fast, or failure-watch semantics.",
			"An armed idle call coalesces matching notifications and requests that the parent run settle; the harness resumes it when the condition resolves.",
			"Agent idle policies: any_settled=first result, quorum=enough, all_succeeded=fail-fast success, first_failure=failure watch.",
			"Agent disconnectPolicy continue_headless permits one tool-free continuation after clean application exit; defer waits for this session.",
			"Use agent wait only for one brief in-turn check while other work remains; never loop on wait.",
			"Agent stop is cancellation, not a waiting mechanism. Use it only when the result is no longer wanted; an in-flight operation may finish before the agent stops.",
			"Give concurrent writers separate files or worktrees.",
		],
		parameters: agentParameters,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const details = (await invoke(
					ctx,
					toolCallId,
					params as AgentAction,
				)) as any;
				switch ((params as AgentAction).action) {
					case "spawn":
						return result(spawnContent(details), details);
					case "list":
						return result(
							details.agents.length
								? details.agents
										.map(
											(agent: any) =>
												`${agentStateLine(agent)}${agent.name ? ` · ${agent.name}` : ""}${usageLine(agent.usage) ? ` · ${usageLine(agent.usage)}` : ""}`,
										)
										.join("\n")
								: "No agents belong to this parent session.",
							details,
						);
					case "inspect":
						return result(
							`${agentStateLine(details.agent)}.${usageLine(details.usage) ? ` Run usage: ${usageLine(details.usage)}.` : ""}${usageLine(details.usage, true) ? ` Lifetime usage: ${usageLine(details.usage, true)} across ${details.usage.lifetime.runs} run(s).` : ""}${details.diagnostics?.cooldown ? ` Provider cooldown: ${details.diagnostics.cooldown.kind}, ${details.diagnostics.cooldown.attempts} probe(s)${details.diagnostics.cooldown.notBefore ? `, not before ${details.diagnostics.cooldown.notBefore}` : ""}.` : ""}`,
							details,
						);
					case "inspect_many":
						return result(
							details.agents
								.map(
									(value: any) =>
										`${agentStateLine(value.agent)}${usageLine(value.usage) ? ` · ${usageLine(value.usage)}` : ""}`,
								)
								.join("\n\n"),
							details,
						);
					case "wait": {
						const guidance = details.agents.some(
							(agent: AgentStateDetails) =>
								!["completed", "failed", "stopped"].includes(agent.state),
						)
							? " Do not poll again: continue independent work or end your turn; completion will resume this parent automatically. Use idle only to join a group under a completion condition."
							: "";
						return result(
							`${
								details.timedOut
									? `No meaningful change before timeout. ${details.agents.map(agentStateLine).join(", ")}`
									: `${details.events.map((event: any) => `${event.id} ${event.agentId} ${event.type}`).join("\n")}\n${details.agents.map(agentStateLine).join(", ")}`
							}${guidance}`,
							details,
						);
					}
					case "idle":
						return idleResult(details);
					case "idle_list":
						return result(
							details.idles.length
								? details.idles
										.map(
											(idle: any) =>
												`${idle.idleId} ${idle.state} ${idle.until}: ${idle.agents.map((agent: any) => `${agent.agentId}:${agent.state}`).join(", ")}`,
										)
										.join("\n")
								: "No idle barriers belong to this parent session.",
							details,
						);
					case "idle_inspect":
						return result(
							`${details.barrier.idleId} is ${details.barrier.state} (${details.barrier.until}). ${details.agents.map((agent: any) => `${agent.agentId}:${agent.state} (${agent.summary})`).join(", ")}`,
							details,
						);
					case "idle_update":
						return result(
							`${details.idleId} ${details.state}: ${details.agents.map((agent: any) => `${agent.agentId}:${agent.state} (${agent.summary})`).join(", ")}`,
							details,
						);
					case "idle_cancel":
						return result(`${details.idleId}: ${details.state}`, details);
					case "catalog":
						return result(catalogContent(details), details);
					case "stop":
						return result(
							`Cancellation requested for ${details.agentId}; state is ${details.state}. An in-flight operation may finish before it stops.`,
							details,
						);
					default:
						return result(
							`${details.agentId} ${details.runId ?? ""}: ${details.state ?? details.deliveryState ?? "accepted"}${details.reason ? ` (${details.reason})` : ""}${details.probeAgentId ? ` · shared probe ${details.probeAgentId}` : ""}`,
							details,
						);
				}
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerCommand("agents", {
		description:
			"Inspect or control child agents and idle barriers: /agents [status|idles|idle|cancel-idle|inspect|pause|resume|stop|stop-all] [id]",
		handler: async (args, ctx) => {
			const [command = "status", agentId, option] = args.trim().split(/\s+/);
			try {
				if (command === "status" || command === "list") {
					const value = (await invoke(ctx, `command-${Date.now()}`, {
						action: "list",
					})) as any;
					const idles = (await invoke(ctx, `command-idles-${Date.now()}`, {
						action: "idle_list",
						state: "pending",
					})) as any;
					const agentsText = value.agents.length
						? value.agents
								.map(
									(agent: any) =>
										`${agent.agentId} · ${agent.state} · ${agent.model.provider}/${agent.model.id} · ${agent.reasoning}${agent.reason ? ` · ${agent.reason}` : ""}${usageLine(agent.usage) ? ` · ${usageLine(agent.usage)}` : ""}`,
								)
								.join("\n")
						: "No agents for this session";
					const idleText = idles.idles.length
						? `\n\nIdle barriers:\n${idles.idles.map((idle: any) => `${idle.idleId} · ${idle.until} · ${idle.agents.map((agent: any) => `${agent.agentId}:${agent.state}`).join(", ")}`).join("\n")}`
						: "";
					ctx.ui.notify(`${agentsText}${idleText}`, "info");
					return;
				}
				if (command === "idles") {
					const value = (await invoke(ctx, `command-idles-${Date.now()}`, {
						action: "idle_list",
					})) as any;
					ctx.ui.notify(
						value.idles.length
							? value.idles
									.map(
										(idle: any) =>
											`${idle.idleId} · ${idle.state} · ${idle.until} · ${idle.agents.map((agent: any) => `${agent.agentId}:${agent.state}`).join(", ")}`,
									)
									.join("\n")
							: "No idle barriers for this session",
						"info",
					);
					return;
				}
				if (command === "stop-all") {
					const value = (await invoke(ctx, `command-list-${Date.now()}`, {
						action: "list",
					})) as any;
					for (const agent of value.agents)
						if (!["completed", "failed", "stopped"].includes(agent.state))
							await invoke(ctx, `command-stop-${agent.agentId}-${Date.now()}`, {
								action: "stop",
								agentId: agent.agentId,
								reason: "Stopped with /agents stop-all",
							});
					ctx.ui.notify(
						`Stop requested for ${value.agents.filter((agent: any) => !["completed", "failed", "stopped"].includes(agent.state)).length} agent(s)`,
						"info",
					);
					return;
				}
				if (!agentId) throw new Error(`Usage: /agents ${command} <agent-id>`);
				const action: AgentAction =
					command === "inspect"
						? { action: "inspect", agentId }
						: command === "idle"
							? { action: "idle_inspect", idleId: agentId }
							: command === "cancel-idle"
								? {
										action: "idle_cancel",
										idleId: agentId,
										requestId: `command-${Date.now()}`,
									}
								: command === "pause"
									? {
											action: "pause",
											agentId,
											...(option === "interrupt"
												? { mode: "interrupt" as const }
												: {}),
										}
									: command === "resume"
										? { action: "resume", agentId }
										: command === "stop"
											? {
													action: "stop",
													agentId,
													reason: "Stopped with /agents",
												}
											: (() => {
													throw new Error(
														`Unknown /agents command: ${command}`,
													);
												})();
				const value = (await invoke(
					ctx,
					`command-${command}-${agentId}-${Date.now()}`,
					action,
				)) as any;
				ctx.ui.notify(
					command === "inspect"
						? [
								`${value.agent.agentId}: ${value.agent.state}${value.agent.reason ? ` (${value.agent.reason})` : ""}`,
								`run ${value.agent.runId} · generation ${value.diagnostics.worker.generation} · desired ${value.agent.desiredState}`,
								`model ${value.agent.model.provider}/${value.agent.model.id} · reasoning ${value.agent.reasoning}`,
								`workspace ${value.diagnostics.workspace.mode}: ${value.agent.cwd}${value.diagnostics.workspace.baseRevision ? ` @ ${value.diagnostics.workspace.baseRevision}` : ""}`,
								usageLine(value.usage)
									? `run usage ${usageLine(value.usage)}`
									: "run usage unavailable",
								usageLine(value.usage, true)
									? `lifetime usage ${usageLine(value.usage, true)} across ${value.usage.lifetime.runs} run(s)`
									: undefined,
								value.usage.limits.runtimeSeconds
									? `runtime limit ${value.usage.limits.runtimeSeconds.toLocaleString()} seconds`
									: undefined,
								value.diagnostics.cooldown
									? `cooldown ${value.diagnostics.cooldown.kind} · ${value.diagnostics.cooldown.provenance}${value.diagnostics.cooldown.notBefore ? ` · not before ${value.diagnostics.cooldown.notBefore}` : ""}`
									: undefined,
								value.diagnostics.uncertainOperations.length
									? `uncertain: ${value.diagnostics.uncertainOperations.map((item: any) => `${item.toolName}/${item.toolCallId}`).join(", ")}`
									: undefined,
								value.pendingMessages.length
									? `pending controls: ${value.pendingMessages.map((item: any) => `${item.messageId}/${item.state}`).join(", ")}`
									: undefined,
								value.output ? value.output.slice(0, 4000) : undefined,
							]
								.filter(Boolean)
								.join("\n")
						: `${agentId}: ${value.state}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
