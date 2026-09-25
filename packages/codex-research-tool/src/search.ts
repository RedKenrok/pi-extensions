import type {
	AgentToolResult,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AuthResult } from "./auth.ts";
import {
	type CodexClient,
	type ModelOption,
	ResearchError,
	type ResearchErrorCode,
} from "./codex.ts";

export const TOOL_NAME = "research";
export const TOOL_DESCRIPTION =
	"Research the web and answer concisely with source links. Use for current facts, documentation, or evidence. Put all context in the query; verify key claims from cited sources.";
export const MAX_RESULT_CHARS = 20_000;
export const RESEARCH_DEADLINE_MS = 10 * 60_000;

export interface ResearchSource {
	title: string;
	url: string;
}

export interface ResearchDetails {
	status: "ok" | "uncited" | "error";
	query: string;
	answer?: string;
	sources: ResearchSource[];
	model?: string;
	effort?: string;
	responseId?: string;
	elapsedMs: number;
	truncated: boolean;
	error?: {
		code: ResearchErrorCode;
		message: string;
		retryable: boolean;
		retryAfterSeconds?: number;
		modelOptions?: ModelOption[];
	};
}

export interface ResearchToolDependencies {
	authCheck(signal?: AbortSignal): Promise<AuthResult>;
	client: CodexClient;
	onUnavailable(
		reason: "credentials" | "backend",
		code?: ResearchErrorCode,
	): void;
	runtimeSignal?: AbortSignal;
	deadlineMs?: number;
	now?: () => number;
}

const parameters = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			maxLength: 4000,
			description:
				"Self-contained question; include relevant versions, dates, or preferred sources.",
		}),
		model: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 128,
				description: "Exact subscription model ID; omit to prefer Luna.",
			}),
		),
		effort: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 32,
				description:
					"Supported reasoning effort (e.g. low, medium, high, xhigh).",
			}),
		),
	},
	{ additionalProperties: false },
);

function isHttpUrl(url: string): boolean {
	try {
		return ["http:", "https:"].includes(new URL(url).protocol);
	} catch {
		return false;
	}
}

function applyCitationMarkers(
	answer: string,
	citations: Array<{
		url: string;
		startIndex?: number;
		endIndex?: number;
	}>,
	sources: ResearchSource[],
): string {
	const sourceNumber = new Map(
		sources.map((source, index) => [source.url, index + 1]),
	);
	const insertions = new Map<number, Set<number>>();
	for (const citation of citations) {
		const number = sourceNumber.get(citation.url);
		if (
			!number ||
			citation.startIndex === undefined ||
			citation.endIndex === undefined ||
			citation.startIndex < 0 ||
			citation.endIndex < citation.startIndex ||
			citation.endIndex > answer.length
		) {
			continue;
		}
		const existing = insertions.get(citation.endIndex) ?? new Set<number>();
		existing.add(number);
		insertions.set(citation.endIndex, existing);
	}
	let rendered = answer;
	for (const [index, numbers] of [...insertions.entries()].sort(
		(a, b) => b[0] - a[0],
	)) {
		const marker = [...numbers]
			.sort((a, b) => a - b)
			.map((number) => `[${number}]`)
			.join("");
		rendered = `${rendered.slice(0, index)} ${marker}${rendered.slice(index)}`;
	}
	return rendered;
}

export function formatSuccess(
	query: string,
	result: Awaited<ReturnType<CodexClient["runResearch"]>>,
	elapsedMs: number,
): AgentToolResult<ResearchDetails> {
	const sources: ResearchSource[] = [];
	const seen = new Set<string>();
	for (const citation of result.citations) {
		if (!isHttpUrl(citation.url) || seen.has(citation.url)) continue;
		seen.add(citation.url);
		sources.push({
			title: citation.title.trim() || citation.url,
			url: citation.url,
		});
	}
	let truncated = false;
	const sourceLines: string[] = [];
	const renderedSources: ResearchSource[] = [];
	let sourceChars = 0;
	for (let index = 0; index < sources.length; index += 1) {
		const source = sources[index];
		if (!source) continue;
		const title =
			source.title.length > 300
				? `${source.title.slice(0, 297)}...`
				: source.title;
		const line = `[${index + 1}] ${title} — ${source.url}`;
		if (sourceChars + line.length + 1 > 6_000) {
			truncated = true;
			break;
		}
		sourceLines.push(line);
		renderedSources.push({ title, url: source.url });
		sourceChars += line.length + 1;
	}
	let answer = applyCitationMarkers(
		result.answer,
		result.citations,
		renderedSources,
	).trim();
	const status = renderedSources.length > 0 ? "ok" : "uncited";
	const warning =
		status === "uncited"
			? "\n\nNo source citations were returned; this answer is not source-verified."
			: "";
	const execution = `Model: ${result.model}${result.effort ? `\nReasoning effort: ${result.effort}` : ""}`;
	const prefix = `Status: ${status}\nQuery: ${query}\n${execution}\n\nAnswer:\n`;
	const sourcesBlock = `\n\nSources:\n${sourceLines.length > 0 ? sourceLines.join("\n") : "(none)"}`;
	const truncationNotice =
		"\n\n[Result truncated to the 20,000 character limit.]";
	const untruncatedBudget =
		MAX_RESULT_CHARS - prefix.length - warning.length - sourcesBlock.length;
	if (answer.length > untruncatedBudget) {
		truncated = true;
	}
	if (truncated) {
		const answerBudget = Math.max(
			0,
			MAX_RESULT_CHARS -
				prefix.length -
				warning.length -
				sourcesBlock.length -
				truncationNotice.length,
		);
		if (answer.length > answerBudget) {
			answer =
				answerBudget > 0
					? `${answer.slice(0, Math.max(0, answerBudget - 1)).trimEnd()}…`
					: "";
		}
	}
	const text = `${prefix}${answer}${warning}${sourcesBlock}${truncated ? truncationNotice : ""}`;
	return {
		content: [{ type: "text", text }],
		details: {
			status,
			query,
			answer,
			sources: renderedSources,
			model: result.model,
			...(result.effort ? { effort: result.effort } : {}),
			...(result.responseId ? { responseId: result.responseId } : {}),
			elapsedMs,
			truncated,
		},
	};
}

function unavailableError(
	auth: Exclude<AuthResult, { kind: "ready" }>,
): ResearchError {
	return new ResearchError("auth_required", auth.message, false);
}

function deadlineSignal(
	timeoutMs: number,
	...parents: Array<AbortSignal | undefined>
): {
	signal: AbortSignal;
	cleanup(): void;
} {
	const controller = new AbortController();
	const timer = setTimeout(
		() =>
			controller.abort(
				new DOMException("Research deadline exceeded", "TimeoutError"),
			),
		timeoutMs,
	);
	const listeners = parents
		.filter((parent): parent is AbortSignal => Boolean(parent))
		.map((parent) => {
			const onAbort = () => controller.abort(parent.reason);
			parent.addEventListener("abort", onAbort, { once: true });
			if (parent.aborted) onAbort();
			return { parent, onAbort };
		});
	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timer);
			for (const { parent, onAbort } of listeners) {
				parent.removeEventListener("abort", onAbort);
			}
		},
	};
}

function backendDisables(code: ResearchErrorCode): boolean {
	return [
		"auth_required",
		"access_denied",
		"client_outdated",
		"backend_incompatible",
	].includes(code);
}

export function createResearchTool(
	dependencies: ResearchToolDependencies,
): ToolDefinition<typeof parameters, ResearchDetails> {
	const now = dependencies.now ?? Date.now;
	return {
		name: TOOL_NAME,
		label: "Research",
		description: TOOL_DESCRIPTION,
		parameters,
		executionMode: "parallel",
		async execute(
			_toolCallId,
			params,
			signal,
			onUpdate,
			_ctx: ExtensionContext,
		) {
			const started = now();
			const query = typeof params.query === "string" ? params.query.trim() : "";
			const requestedModel =
				typeof params.model === "string" ? params.model.trim() : undefined;
			const requestedEffort =
				typeof params.effort === "string" ? params.effort.trim() : undefined;
			if (!query || query.length > 4000) {
				throw new ResearchError(
					"invalid_input",
					query
						? "The research query exceeds 4,000 characters."
						: "The research query is empty.",
					false,
				);
			}
			if (
				params.model !== undefined &&
				(!requestedModel || requestedModel.length > 128)
			) {
				throw new ResearchError(
					"invalid_input",
					"The research model must be a non-empty model ID of at most 128 characters.",
					false,
				);
			}
			if (
				params.effort !== undefined &&
				(!requestedEffort || requestedEffort.length > 32)
			) {
				throw new ResearchError(
					"invalid_input",
					"The research effort must be a non-empty reasoning level of at most 32 characters.",
					false,
				);
			}
			const deadline = deadlineSignal(
				dependencies.deadlineMs ?? RESEARCH_DEADLINE_MS,
				signal,
				dependencies.runtimeSignal,
			);
			try {
				if (deadline.signal.aborted) {
					throw new ResearchError(
						deadline.signal.reason instanceof Error &&
							deadline.signal.reason.name === "TimeoutError"
							? "timeout"
							: "cancelled",
						deadline.signal.reason instanceof Error &&
							deadline.signal.reason.name === "TimeoutError"
							? "Research timed out after 10 minutes."
							: "Research was cancelled.",
						false,
					);
				}
				onUpdate?.({
					content: [{ type: "text", text: `Research: ${query}\n\nSearching…` }],
					details: {
						status: "ok",
						query,
						sources: [],
						elapsedMs: now() - started,
						truncated: false,
					},
				});
				const auth = await dependencies.authCheck(deadline.signal);
				if (auth.kind !== "ready") {
					if (deadline.signal.aborted) {
						throw new ResearchError(
							deadline.signal.reason instanceof Error &&
								deadline.signal.reason.name === "TimeoutError"
								? "timeout"
								: "cancelled",
							deadline.signal.reason instanceof Error &&
								deadline.signal.reason.name === "TimeoutError"
								? "Research timed out after 10 minutes."
								: "Research was cancelled.",
							false,
						);
					}
					if (auth.reason === "check_timeout") {
						throw new ResearchError(
							"timeout",
							"Research timed out after 10 minutes.",
							false,
						);
					}
					dependencies.onUnavailable("credentials", "auth_required");
					throw unavailableError(auth);
				}
				if (deadline.signal.aborted) {
					throw deadline.signal.reason instanceof Error &&
						deadline.signal.reason.name === "TimeoutError"
						? new ResearchError(
								"timeout",
								"Research timed out after 10 minutes.",
								false,
							)
						: new ResearchError("cancelled", "Research was cancelled.", false);
				}
				const model = await dependencies.client.selectModel(
					auth,
					deadline.signal,
					requestedModel,
					requestedEffort,
				);
				const result = await dependencies.client.runResearch({
					query,
					auth,
					model,
					...(requestedEffort ? { effort: requestedEffort } : {}),
					signal: deadline.signal,
					onProgress(text) {
						const preview = text.replace(/\s+/g, " ").trim().slice(0, 240);
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `Research: ${query}\n\nSearching…${preview ? `\n${preview}` : ""}`,
								},
							],
							details: {
								status: "ok",
								query,
								sources: [],
								elapsedMs: now() - started,
								truncated: false,
							},
						});
					},
				});
				return formatSuccess(query, result, now() - started);
			} catch (cause) {
				const error = deadline.signal.aborted
					? new ResearchError(
							deadline.signal.reason instanceof Error &&
								deadline.signal.reason.name === "TimeoutError"
								? "timeout"
								: "cancelled",
							deadline.signal.reason instanceof Error &&
								deadline.signal.reason.name === "TimeoutError"
								? "Research timed out after 10 minutes."
								: "Research was cancelled.",
							false,
						)
					: cause instanceof ResearchError
						? cause
						: new ResearchError(
								"network",
								"Codex research could not reach the backend.",
								true,
							);
				const disabled = backendDisables(error.code);
				if (disabled) dependencies.onUnavailable("backend", error.code);
				throw error;
			} finally {
				deadline.cleanup();
			}
		},
		renderCall(args, theme) {
			const query = typeof args.query === "string" ? args.query : "";
			return new Text(
				theme.fg("toolTitle", theme.bold(`Research: ${query}`)),
				0,
				0,
			);
		},
		renderResult(result, options, theme) {
			const text = result.content
				.filter(
					(block): block is { type: "text"; text: string } =>
						block.type === "text",
				)
				.map((block) => block.text)
				.join("\n");
			if (options.expanded || options.isPartial) {
				return new Text(
					theme.fg(
						result.details?.status === "error" ? "error" : "toolOutput",
						`\n${text}`,
					),
					0,
					0,
				);
			}
			const preview = text.replace(/\s+/g, " ").trim().slice(0, 320);
			const count = result.details?.sources.length ?? 0;
			return new Text(
				theme.fg(
					result.details?.status === "error" ? "error" : "toolOutput",
					`\n${preview}${text.length > preview.length ? "…" : ""}\n${count} source${count === 1 ? "" : "s"}`,
				),
				0,
				0,
			);
		},
	};
}
