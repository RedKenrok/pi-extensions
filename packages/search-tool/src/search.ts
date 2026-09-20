import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import domino from "@mixmark-io/domino";
import { Type } from "typebox";
import { DEFAULT_MAX_RESPONSE_SIZE, DEFAULT_TIMEOUT } from "./constants.ts";
import { buildErrorResponse, normalizeError } from "./error.ts";
import { buildHeaders } from "./headers.ts";
import { createTimeoutSignal } from "./request.ts";
import { readResponseWithLimit } from "./response.ts";

interface SearchResult {
	title: string;
	url: string;
	description: string;
}

interface SearchSuccess {
	query: string;
	results: SearchResult[];
}

interface SearchFailure {
	query: string;
	error: ReturnType<typeof normalizeError>;
}

type SearchOutcome = SearchSuccess | SearchFailure;
interface SearchParams {
	queries: string | string[];
	timeout?: number;
}

const SEARCH_URL = "https://html.duckduckgo.com/lite/?kp=1";
const MAX_QUERIES = 8;
const MAX_CONCURRENT_QUERIES = 4;
const MAX_QUERY_LENGTH = 500;
const MAX_SEARCH_RESPONSE_SIZE = Math.min(
	DEFAULT_MAX_RESPONSE_SIZE,
	2 * 1024 * 1024,
);
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 1_000;

const truncate = (value: string, maxLength: number): string =>
	value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;

const isDuckDuckGoHost = (hostname: string): boolean => {
	return hostname === "duckduckgo.com" || hostname.endsWith(".duckduckgo.com");
};

const extractResultUrl = (rawUrl: string): string | undefined => {
	try {
		let parsed = new URL(rawUrl, SEARCH_URL);
		if (isDuckDuckGoHost(parsed.hostname)) {
			const redirectedUrl = parsed.searchParams.get("uddg");
			if (!redirectedUrl) {
				return undefined;
			}
			parsed = new URL(redirectedUrl);
		}

		if (!["http:", "https:"].includes(parsed.protocol)) {
			return undefined;
		}

		return parsed.toString();
	} catch {
		return undefined;
	}
};

const extractResults = (html: string): SearchResult[] => {
	const document = domino.createDocument(html, true);
	const resultNodes = document.querySelectorAll("a.result-link[href]");
	const results: SearchResult[] = [];

	for (let i = 0; i < resultNodes.length; i++) {
		const node = resultNodes.item(i);
		const rawUrl = node.getAttribute("href") ?? "";
		const rawTitle = node.textContent ?? "";
		const rawDescription =
			node.closest("tr")?.nextElementSibling?.querySelector(".result-snippet")
				?.textContent ?? "";

		const url = extractResultUrl(rawUrl);

		const title = rawTitle.trim();
		if (!title || !url) {
			continue;
		}

		results.push({
			title: truncate(title, MAX_TITLE_LENGTH),
			url,
			description: truncate(rawDescription.trim(), MAX_DESCRIPTION_LENGTH),
		});
	}

	return results.slice(0, 10);
};

const searchQuery = async (
	query: string,
	signal: AbortSignal | undefined,
	timeout: number | undefined,
): Promise<SearchOutcome> => {
	let cleanup = () => {};
	let getAbortCause: ReturnType<typeof createTimeoutSignal>["getAbortCause"] =
		() => undefined;

	try {
		const timeoutContext = createTimeoutSignal(signal, timeout);
		cleanup = timeoutContext.cleanup;
		getAbortCause = timeoutContext.getAbortCause;
		const headers = buildHeaders({
			Accept: "text/html,application/xhtml+xml",
			"Accept-Language": "en-GB,en;q=0.9",
		});
		const response = await fetch(SEARCH_URL, {
			headers,
			method: "POST",
			redirect: "follow",
			...(timeoutContext.signal ? { signal: timeoutContext.signal } : {}),
			body: new URLSearchParams({ q: query, kl: "", df: "" }),
		});

		if (!response.ok) {
			return {
				query,
				error: {
					errorType: "http",
					message: `HTTP ${response.status} ${response.statusText}`,
					url: SEARCH_URL,
					status: response.status,
					statusText: response.statusText,
				},
			};
		}

		const rawBytes = await readResponseWithLimit(
			response,
			MAX_SEARCH_RESPONSE_SIZE,
		);
		const html = new TextDecoder().decode(rawBytes);
		return { query, results: extractResults(html) };
	} catch (error) {
		return {
			query,
			error: normalizeError(error, SEARCH_URL, timeout, getAbortCause()),
		};
	} finally {
		cleanup();
	}
};

const mapWithConcurrency = async <Input, Output>(
	values: readonly Input[],
	limit: number,
	mapper: (value: Input) => Promise<Output>,
): Promise<Output[]> => {
	const results = new Array<Output>(values.length);
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.min(limit, values.length) },
		async () => {
			while (nextIndex < values.length) {
				const index = nextIndex++;
				const value = values[index];
				if (value !== undefined) results[index] = await mapper(value);
			}
		},
	);
	await Promise.all(workers);
	return results;
};

const formatOutcome = (outcome: SearchOutcome): string => {
	if ("error" in outcome) {
		return `Error searching for "${outcome.query}": ${outcome.error.message}`;
	}

	if (outcome.results.length === 0) {
		return `No results found for: ${outcome.query}`;
	}

	const resultLines = outcome.results.map(
		(result, index) =>
			`${(index + 1).toString().padStart(2)}. ${result.title}${result.description ? `\n    ${result.description}` : ""}\n    URL: ${result.url}`,
	);

	return `Search results for: ${outcome.query}\n\n${resultLines.join("\n\n")}`;
};

export default () => ({
	name: "search",
	label: "Web search",
	description: "Search the web for top results",
	promptSnippet: "Search the web",

	parameters: Type.Object({
		queries: Type.Union([
			Type.String({
				description: "One query",
				maxLength: MAX_QUERY_LENGTH,
			}),
			Type.Array(Type.String({ maxLength: MAX_QUERY_LENGTH }), {
				description: "Queries to run in parallel",
				minItems: 1,
				maxItems: MAX_QUERIES,
			}),
		]),

		timeout: Type.Optional(
			Type.Number({
				description: "Per-query timeout (ms)",
				default: DEFAULT_TIMEOUT,
				minimum: 100,
			}),
		),
	}),

	async execute(
		_toolCallId: string,
		params: SearchParams,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<unknown>> {
		const queries: string[] = (
			Array.isArray(params.queries) ? params.queries : [params.queries]
		).map((query: string) => query.trim());
		const timeout = params.timeout ?? DEFAULT_TIMEOUT;
		if (!Number.isFinite(timeout) || timeout < 100) {
			return buildErrorResponse("Error: Timeout must be at least 100ms", {
				errorType: "validation",
				message: "Timeout must be at least 100ms",
			});
		}

		if (queries.length === 0 || queries.some((query) => !query)) {
			return buildErrorResponse("Error: Search queries must not be empty", {
				errorType: "validation",
				message: "Search queries must not be empty",
			});
		}
		if (queries.length > MAX_QUERIES) {
			return buildErrorResponse(
				`Error: At most ${MAX_QUERIES} search queries may be run at once`,
				{
					errorType: "validation",
					message: `At most ${MAX_QUERIES} search queries may be run at once`,
				},
			);
		}
		if (queries.some((query) => query.length > MAX_QUERY_LENGTH)) {
			return buildErrorResponse(
				`Error: Search queries must not exceed ${MAX_QUERY_LENGTH} characters`,
				{
					errorType: "validation",
					message: `Search queries must not exceed ${MAX_QUERY_LENGTH} characters`,
				},
			);
		}

		const outcomes = await mapWithConcurrency(
			queries,
			MAX_CONCURRENT_QUERIES,
			(query) => searchQuery(query, signal, timeout),
		);

		if (outcomes.length === 1) {
			const outcome = outcomes[0];
			if (!outcome) {
				return buildErrorResponse("Error: Search returned no outcome", {
					errorType: "unknown",
					message: "Search returned no outcome",
				});
			}
			if ("error" in outcome) {
				return buildErrorResponse(formatOutcome(outcome), outcome.error);
			}

			return {
				content: [{ type: "text", text: formatOutcome(outcome) }],
				details: { query: outcome.query, results: outcome.results },
			};
		}

		const allFailed = outcomes.every((outcome) => "error" in outcome);
		return {
			content: [
				{
					type: "text",
					text: outcomes.map(formatOutcome).join("\n\n---\n\n"),
				},
			],
			details: {
				queries,
				results: outcomes,
				allFailed,
			},
		};
	},
});
