// biome-ignore-all lint/style/noNonNullAssertion: Assertions follow session initialization and usage-baseline guards in the worker lifecycle.
// biome-ignore-all lint/suspicious/noExplicitAny: Pi SDK message/event unions are heterogeneous and not exported as a shared public type.
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { normalizeAvailability, sanitize } from "./availability.ts";
import { stableHash } from "./ids.ts";
import { ipcCall } from "./ipc.ts";
import type { MessageRecord } from "./store.ts";
import type { AvailabilityBlock, UsageTotals, WorkerConfig } from "./types.ts";
import { normalizeLimits } from "./types.ts";

type Poll = {
	desiredState: "running" | "paused" | "stopped";
	messages: MessageRecord[];
};

function finalText(messages: readonly any[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant" || !Array.isArray(message.content))
			continue;
		const text = message.content
			.filter((part: any) => part.type === "text")
			.map((part: any) => part.text)
			.join("\n");
		if (text) return text;
	}
	return "(no final text)";
}
function containsControl(messages: readonly any[], messageId: string): boolean {
	const marker = `[pi-tools-control:${messageId}]`;
	return messages.some(
		(message) =>
			Array.isArray(message?.content) &&
			message.content.some(
				(part: any) =>
					part?.type === "text" && String(part.text).includes(marker),
			),
	);
}
function usage(messages: readonly any[]): UsageTotals {
	const result: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: null,
	};
	for (const message of messages) {
		if (message?.role !== "assistant" || !message.usage) continue;
		result.input += Number(message.usage.input ?? 0);
		result.output += Number(message.usage.output ?? 0);
		result.cacheRead += Number(message.usage.cacheRead ?? 0);
		result.cacheWrite += Number(message.usage.cacheWrite ?? 0);
		result.totalTokens += Number(message.usage.totalTokens ?? 0);
		if (typeof message.usage.cost?.total === "number")
			result.cost = (result.cost ?? 0) + message.usage.cost.total;
	}
	return result;
}
function usageDelta(value: UsageTotals, baseline: UsageTotals): UsageTotals {
	return {
		input: Math.max(0, value.input - baseline.input),
		output: Math.max(0, value.output - baseline.output),
		cacheRead: Math.max(0, value.cacheRead - baseline.cacheRead),
		cacheWrite: Math.max(0, value.cacheWrite - baseline.cacheWrite),
		totalTokens: Math.max(0, value.totalTokens - baseline.totalTokens),
		cost:
			value.cost === null
				? null
				: Math.max(0, value.cost - (baseline.cost ?? 0)),
	};
}

export async function runWorker(configPath: string): Promise<void> {
	const config = JSON.parse(readFileSync(configPath, "utf8")) as WorkerConfig;
	config.config.limits = normalizeLimits(config.config.limits);
	try {
		unlinkSync(configPath);
	} catch {
		/* restrictive file is harmless if cleanup races */
	}
	const token = readFileSync(config.tokenPath, "utf8").trim();
	const send = async (type: string, data: Record<string, unknown> = {}) =>
		await ipcCall(
			config.socketPath,
			token,
			"worker_event",
			{
				agentId: config.agentId,
				runId: config.runId,
				generation: config.generation,
				type,
				...data,
			},
			10_000,
		);
	const poll = async () =>
		(await ipcCall(
			config.socketPath,
			token,
			"worker_poll",
			{
				agentId: config.agentId,
				runId: config.runId,
				generation: config.generation,
			},
			10_000,
		)) as Poll;
	let session:
		| Awaited<ReturnType<typeof createAgentSession>>["session"]
		| undefined;
	let usageBaseline: UsageTotals | undefined;
	let pauseRequested = false;
	let runtimeLimitReached = false;
	let finished = false;
	let pollTimer: NodeJS.Timeout | undefined;
	const submitted = new Set<string>();
	const currentRunUsage = () =>
		session && usageBaseline
			? usageDelta(usage(session.messages), usageBaseline)
			: undefined;
	const shutdown = async () => {
		if (finished) return;
		finished = true;
		try {
			session?.abortCompaction();
		} catch {
			/* no compaction */
		}
		try {
			await session?.abort();
		} catch {
			/* already idle */
		}
		const checkpointUsage = currentRunUsage();
		if (checkpointUsage)
			try {
				await send("usage", { usage: checkpointUsage });
			} catch {
				/* supervisor may be restarting */
			}
		try {
			await send("paused");
		} catch {
			/* supervisor may be restarting */
		}
		session?.dispose();
		process.exitCode = 0;
	};
	process.once("SIGTERM", () => void shutdown());
	process.once("SIGINT", () => void shutdown());
	try {
		const runtime = await ModelRuntime.create({
			authPath: join(config.agentDir, "auth.json"),
			modelsPath: join(config.agentDir, "models.json"),
			modelsStorePath: join(config.agentDir, "models-store.json"),
			allowModelNetwork: false,
		});
		const model = runtime.getModel(
			config.config.model.provider,
			config.config.model.id,
		);
		if (!model)
			throw Object.assign(
				new Error(
					`Saved model ${config.config.model.provider}/${config.config.model.id} is unavailable`,
				),
				{ code: "model_not_found" },
			);
		const available = await runtime.getAvailable(model.provider, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!available.some((item) => item.id === model.id))
			throw Object.assign(
				new Error(
					`Authentication is unavailable for ${model.provider}/${model.id}`,
				),
				{ status: 401 },
			);
		const levels = getSupportedThinkingLevels(model);
		if (!levels.includes(config.config.reasoning))
			throw Object.assign(
				new Error(
					`Saved reasoning ${config.config.reasoning} is unsupported by ${model.provider}/${model.id}`,
				),
				{ code: "unsupported_reasoning" },
			);
		const hook: InlineExtension = {
			name: "pi-tools-worker-guard",
			factory: (pi) => {
				pi.on("tool_call", async (event) => {
					await send("tool_start", {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						argsHash: stableHash(event.input),
					});
					if (pauseRequested)
						return {
							block: true,
							reason: "Durable pause requested before tool dispatch",
							terminate: true,
						};
				});
				pi.on("tool_result", async (event) => {
					await send("tool_end", {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						isError: event.isError,
					});
				});
			},
		};
		const allowedTools = new Set(
			config.config.tools.filter((name) => name !== "agent"),
		);
		const settings = SettingsManager.create(config.config.cwd, config.agentDir);
		settings.applyOverrides({ retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: config.config.cwd,
			agentDir: config.agentDir,
			settingsManager: settings,
			additionalExtensionPaths: config.config.extensionPaths ?? [],
			noExtensions: true,
			noPromptTemplates: true,
			extensionFactories: [hook],
			extensionsOverride: (base) => ({
				...base,
				extensions: base.extensions.flatMap((extension) => {
					if (extension.path === "<inline:pi-tools-worker-guard>")
						return [extension];
					const tools = new Map(
						[...extension.tools].filter(
							([name]) => name !== "agent" && allowedTools.has(name),
						),
					);
					return tools.size ? [{ ...extension, tools }] : [];
				}),
			}),
			appendSystemPrompt: config.config.instructions
				? [
						config.config.instructions,
						"You are a child agent. Do not delegate to other agents.",
					]
				: ["You are a child agent. Do not delegate to other agents."],
		});
		await loader.reload();
		const sessionManager = config.sessionFile
			? SessionManager.open(
					config.sessionFile,
					join(config.stateDir, "sessions", config.agentId),
					config.config.cwd,
				)
			: SessionManager.create(
					config.config.cwd,
					join(config.stateDir, "sessions", config.agentId),
					{ id: config.agentId },
				);
		({ session } = await createAgentSession({
			cwd: config.config.cwd,
			agentDir: config.agentDir,
			modelRuntime: runtime,
			model,
			thinkingLevel: config.config.reasoning,
			tools: [...allowedTools],
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager,
		}));
		// SDK callers must bind extensions explicitly. Besides applying the worker
		// mode, this emits session_start so tools registered lazily by extensions
		// (for example after an availability check) exist before validation.
		await session.bindExtensions({ mode: "rpc" });
		const activeTools = new Set(session.getActiveToolNames());
		const missingTools = [...allowedTools].filter(
			(name) => !activeTools.has(name),
		);
		if (missingTools.length)
			throw Object.assign(
				new Error(
					`Selected parent tool(s) could not be loaded in the isolated worker: ${missingTools.join(", ")}`,
				),
				{ code: "worker_tool_unavailable" },
			);
		if (activeTools.has("agent"))
			throw Object.assign(
				new Error("The recursive agent tool was loaded in a child worker"),
				{ code: "recursive_agent_tool" },
			);
		usageBaseline = usage(session.messages);
		await send("session", {
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			checkpoint: sessionManager.getLeafId(),
		});
		const initialControl = await poll();
		for (const message of initialControl.messages) {
			if (containsControl(session.messages, message.messageId)) {
				submitted.add(message.messageId);
				await send("message_applied", { messageId: message.messageId });
			} else if (message.state === "submitted")
				throw Object.assign(
					new Error(
						`Control ${message.messageId} was submitted but is absent from the saved transcript. Resume with "reconcile message ${message.messageId}: retry" or "reconcile message ${message.messageId}: skip".`,
					),
					{ code: "recovery_required" },
				);
		}
		session.subscribe((event: any) => {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent?.type === "text_delta"
			)
				void send("output", { text: event.assistantMessageEvent.delta });
			if (event.type === "turn_end") {
				void send("usage", {
					usage: usageDelta(usage(session!.messages), usageBaseline!),
				});
				if (pauseRequested) void session?.abort();
			}
		});
		const started = Date.now();
		pollTimer = setInterval(() => {
			void (async () => {
				const control = await poll();
				if (control.desiredState !== "running") {
					pauseRequested = true;
					if (control.desiredState === "stopped") {
						session?.abortCompaction();
						await session?.abort();
					}
				}
				for (const message of control.messages) {
					if (submitted.has(message.messageId)) continue;
					submitted.add(message.messageId);
					const controlText = `[pi-tools-control:${message.messageId}]\n${message.text}`;
					void session
						?.prompt(controlText, {
							expandPromptTemplates: false,
							streamingBehavior: message.delivery,
							preflightResult: (accepted) => {
								if (accepted)
									void send("message_submitted", {
										messageId: message.messageId,
									});
							},
						})
						.then(
							() => send("message_applied", { messageId: message.messageId }),
							() => undefined,
						);
				}
				await send("heartbeat");
				if (
					!runtimeLimitReached &&
					config.config.limits.runtimeSeconds &&
					Date.now() - started >= config.config.limits.runtimeSeconds * 1000
				) {
					runtimeLimitReached = true;
					await session?.abort();
				}
			})().catch(() => undefined);
		}, 500);
		await session.prompt(config.prompt, { expandPromptTemplates: false });
		clearInterval(pollTimer);
		// A signal-triggered shutdown already emitted the terminal paused event.
		// Do not let the prompt-abort continuation report it a second time.
		if (finished) return;
		const latest = await poll();
		if (latest.desiredState !== "running" || pauseRequested) {
			await send("usage", { usage: currentRunUsage()! });
			await send("paused");
			finished = true;
			session.dispose();
			return;
		}
		const runUsage = currentRunUsage()!;
		if (runtimeLimitReached) {
			await send("usage", { usage: runUsage });
			await send("failed", {
				code: "runtime_limit",
				message: `Runtime limit reached (${config.config.limits.runtimeSeconds} seconds)`,
				retryable: false,
			});
			finished = true;
			session.dispose();
			return;
		}
		const last = [...session.messages]
			.reverse()
			.find((message: any) => message.role === "assistant") as any;
		if (last?.stopReason === "error") {
			await send("usage", { usage: runUsage });
			const block = normalizeAvailability(
				{ message: last.errorMessage ?? session.agent.state.errorMessage },
				config.config.scopeKey,
			);
			if (block.kind !== "unknown") await send("availability", { block });
			else
				await send("failed", {
					code: "provider_error",
					message: sanitize(
						last.errorMessage ??
							session.agent.state.errorMessage ??
							"Provider error",
					),
					retryable: false,
				});
		} else {
			const fullSummary = finalText(session.messages);
			const outputTruncated =
				Buffer.byteLength(fullSummary, "utf8") > 16 * 1024;
			const summary = sanitize(fullSummary, 16 * 1024);
			await send("session", {
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				checkpoint: sessionManager.getLeafId(),
			});
			await send("complete", {
				summary,
				outputTruncated,
				usage: runUsage,
				checkpoint: sessionManager.getLeafId(),
			});
		}
		finished = true;
		session.dispose();
		await settings.flush();
	} catch (error) {
		if (pollTimer) clearInterval(pollTimer);
		const block: AvailabilityBlock = normalizeAvailability(
			error,
			config.config.scopeKey,
		);
		try {
			const checkpointUsage = currentRunUsage();
			if (checkpointUsage) await send("usage", { usage: checkpointUsage });
			if (block.kind !== "unknown") await send("availability", { block });
			else
				await send("failed", {
					code: (error as any)?.code ?? "worker_failed",
					message: sanitize(
						error instanceof Error ? error.message : String(error),
					),
					retryable: false,
				});
		} catch {
			/* supervisor restart recovery owns the run */
		}
		session?.dispose();
		process.exitCode = 1;
	}
}
