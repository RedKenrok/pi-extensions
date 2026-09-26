import type {
	AgentToolResult,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { AuthResult } from "./auth.ts";
import type { CodexResearchResult, ResearchBackend } from "./codex.ts";
import {
	disablesTool,
	type ModelOption,
	ResearchError,
	type ResearchErrorCode,
	researchError,
} from "./errors.ts";
import {
	MAX_EFFORT_CHARS,
	MAX_MODEL_ID_CHARS,
	MAX_QUERY_CHARS,
	MAX_RESULT_CHARS,
	MAX_SOURCE_TITLE_CHARS,
	MAX_SOURCES_CHARS,
	PROGRESS_INTERVAL_MS,
	PROGRESS_PREVIEW_CHARS,
	RESEARCH_DEADLINE_MS,
} from "./limits.ts";
import { diagnose, formatDuration, isTimeoutReason } from "./util.ts";

export { MAX_RESULT_CHARS, RESEARCH_DEADLINE_MS } from "./limits.ts";

export const TOOL_NAME = "research";
export const TOOL_DESCRIPTION =
	"Research the web and answer concisely with source links. Use for current facts, documentation, or evidence. Put all context in the query; verify key claims from cited sources.";

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
	client: ResearchBackend;
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
			maxLength: MAX_QUERY_CHARS,
			description:
				"Self-contained question; include relevant versions, dates, or preferred sources.",
		}),
		model: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_MODEL_ID_CHARS,
				description: "Exact subscription model ID; omit to prefer Luna.",
			}),
		),
		effort: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_EFFORT_CHARS,
				description:
					"Supported reasoning effort (e.g. low, medium, high, xhigh).",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ResearchParams = Static<typeof parameters>;

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
	result: CodexResearchResult,
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
	for (const [index, source] of sources.entries()) {
		const title =
			source.title.length > MAX_SOURCE_TITLE_CHARS
				? `${source.title.slice(0, MAX_SOURCE_TITLE_CHARS - 3)}...`
				: source.title;
		const line = `[${index + 1}] ${title} (${source.url})`;
		if (sourceChars + line.length + 1 > MAX_SOURCES_CHARS) {
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
	const truncationNotice = `\n\n[Result truncated to the ${MAX_RESULT_CHARS.toLocaleString("en-US")} character limit.]`;
	const untruncatedBudget =
		MAX_RESULT_CHARS - prefix.length - warning.length - sourcesBlock.length;
	if (answer.length > untruncatedBudget) {
		truncated = true;
	}
	if (truncated) {
		const answerBudget = Math.max(
			0,
			untruncatedBudget - truncationNotice.length,
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

/**
 * Turns an aborted deadline signal into the error the caller sees. The message
 * names the configured deadline, because a fixed duration would be wrong for
 * any non-default deadline.
 */
function deadlineFailure(
	signal: AbortSignal,
	deadlineMs: number,
): ResearchError {
	return isTimeoutReason(signal.reason)
		? researchError(
				"timeout",
				`Research timed out after ${formatDuration(deadlineMs)}.`,
			)
		: researchError("cancelled");
}

function validateParams(params: ResearchParams): {
	query: string;
	model: string | undefined;
	effort: string | undefined;
} {
	const query = typeof params.query === "string" ? params.query.trim() : "";
	const model =
		typeof params.model === "string" ? params.model.trim() : undefined;
	const effort =
		typeof params.effort === "string" ? params.effort.trim() : undefined;
	if (!query || query.length > MAX_QUERY_CHARS) {
		throw researchError(
			"invalid_input",
			query
				? `The research query exceeds ${MAX_QUERY_CHARS.toLocaleString("en-US")} characters.`
				: "The research query is empty.",
		);
	}
	if (
		params.model !== undefined &&
		(!model || model.length > MAX_MODEL_ID_CHARS)
	) {
		throw researchError(
			"invalid_input",
			`The research model must be a non-empty model ID of at most ${MAX_MODEL_ID_CHARS} characters.`,
		);
	}
	if (
		params.effort !== undefined &&
		(!effort || effort.length > MAX_EFFORT_CHARS)
	) {
		throw researchError(
			"invalid_input",
			`The research effort must be a non-empty reasoning level of at most ${MAX_EFFORT_CHARS} characters.`,
		);
	}
	return { query, model, effort };
}

function progressText(query: string, preview: string): string {
	return `Research: ${query}\n\nSearching…${preview ? `\n${preview}` : ""}`;
}

/**
 * Builds the progress preview from the end of the streamed text, so the user
 * sees the answer advancing instead of a frozen opening sentence. Only a
 * bounded tail is normalized, which keeps each update constant-time however
 * long the answer grows.
 */
export function progressPreview(text: string): string {
	const tail = text.slice(-PROGRESS_PREVIEW_CHARS * 4);
	const normalized = tail.replace(/\s+/g, " ").trim();
	if (
		normalized.length <= PROGRESS_PREVIEW_CHARS &&
		tail.length === text.length
	)
		return normalized;
	return `…${normalized.slice(-(PROGRESS_PREVIEW_CHARS - 1)).trimStart()}`;
}

export function createResearchTool(
	dependencies: ResearchToolDependencies,
): ToolDefinition<typeof parameters, ResearchDetails> {
	const now = dependencies.now ?? Date.now;
	const deadlineMs = dependencies.deadlineMs ?? RESEARCH_DEADLINE_MS;
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
			const {
				query,
				model: requestedModel,
				effort: requestedEffort,
			} = validateParams(params);
			const deadline = AbortSignal.any(
				[
					AbortSignal.timeout(deadlineMs),
					signal,
					dependencies.runtimeSignal,
				].filter((value): value is AbortSignal => value !== undefined),
			);
			let settled = false;
			let lastProgressAt: number | undefined;
			const update = (preview: string) => {
				if (settled) return;
				onUpdate?.({
					content: [{ type: "text", text: progressText(query, preview) }],
					details: {
						status: "ok",
						query,
						sources: [],
						elapsedMs: now() - started,
						truncated: false,
					},
				});
			};
			try {
				if (deadline.aborted) throw deadlineFailure(deadline, deadlineMs);
				update("");
				const auth = await dependencies.authCheck(deadline);
				if (deadline.aborted) throw deadlineFailure(deadline, deadlineMs);
				if (auth.kind !== "ready") {
					if (auth.reason === "check_timeout") {
						throw researchError(
							"timeout",
							"Research could not check authentication in time.",
						);
					}
					if (auth.reason === "check_cancelled") {
						throw researchError("cancelled");
					}
					dependencies.onUnavailable("credentials", "auth_required");
					throw researchError("auth_required", auth.message);
				}
				const model = await dependencies.client.selectModel(
					auth,
					deadline,
					requestedModel,
					requestedEffort,
				);
				const result = await dependencies.client.runResearch({
					query,
					auth,
					model,
					...(requestedEffort ? { effort: requestedEffort } : {}),
					signal: deadline,
					onProgress(text) {
						const at = now();
						if (
							lastProgressAt !== undefined &&
							at - lastProgressAt < PROGRESS_INTERVAL_MS
						)
							return;
						lastProgressAt = at;
						update(progressPreview(text));
					},
				});
				return formatSuccess(query, result, now() - started);
			} catch (cause) {
				const error = deadline.aborted
					? deadlineFailure(deadline, deadlineMs)
					: cause instanceof ResearchError
						? cause
						: researchError("network");
				diagnose(`research:error:${error.code}`);
				if (disablesTool(error.code))
					dependencies.onUnavailable("backend", error.code);
				throw error;
			} finally {
				settled = true;
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
