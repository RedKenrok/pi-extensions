import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	DEFAULT_BINARY_PREVIEW_SIZE,
	DEFAULT_MAX_DOWNLOAD_SIZE,
	DEFAULT_MAX_OUTPUT_SIZE,
	DEFAULT_MAX_RESPONSE_SIZE,
	DEFAULT_TIMEOUT,
	MAX_OUTPUT_SIZE,
	MAX_TIMEOUT,
	MIN_OUTPUT_SIZE,
	MIN_TIMEOUT,
} from "./constants.ts";
import {
	type ContentKind,
	classifyContentType,
	isStructuredKind,
	looksLikeText,
} from "./content-type.ts";
import { debug } from "./debug.ts";
import { normalizeError, redactUrl, toolError } from "./error.ts";
import { buildHeaders, findHeaderKey } from "./headers.ts";
import {
	convertHtmlToMarkdown,
	extractTitle,
	type MarkdownResult,
} from "./html.ts";
import { minifyText } from "./minify.ts";
import { createDeadline, type Deadline } from "./request.ts";
import { readResponseWithLimit } from "./response.ts";
import { decodeText, toBase64, truncateText } from "./text.ts";

type BodyType = "binary" | "markdown" | "none" | "text";
type HeaderMode = "all" | "none" | "safe";

/**
 * Reported only when the caller asked for Markdown, so the model can tell a
 * conversion from a response that was returned unchanged.
 */
type MarkdownStatus = "converted" | "failed" | "not_html";

const SAFE_RESPONSE_HEADERS = new Set([
	"cache-control",
	"content-language",
	"content-length",
	"content-type",
	"etag",
	"last-modified",
	"location",
	"retry-after",
]);

const parameters = Type.Object({
	url: Type.String({
		description: "URL to fetch",
	}),

	method: Type.Optional(
		Type.Union(
			[
				Type.Literal("GET"),
				Type.Literal("POST"),
				Type.Literal("PUT"),
				Type.Literal("DELETE"),
				Type.Literal("PATCH"),
				Type.Literal("HEAD"),
				Type.Literal("OPTIONS"),
			],
			{
				default: "GET",
			},
		),
	),

	headers: Type.Optional(Type.Record(Type.String(), Type.String())),

	body: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Record(Type.String(), Type.Any()),
			Type.Array(Type.Any()),
		]),
	),

	timeout: Type.Optional(
		Type.Number({
			description: "Timeout (ms)",
			default: DEFAULT_TIMEOUT,
			minimum: MIN_TIMEOUT,
			maximum: MAX_TIMEOUT,
		}),
	),

	markdown: Type.Optional(
		Type.Boolean({
			description: "Extract main HTML as Markdown",
			default: false,
		}),
	),

	minify: Type.Optional(
		Type.Boolean({
			description: "Minify JSON, NDJSON, XML, or HTML",
			default: true,
		}),
	),

	maxOutputSize: Type.Optional(
		Type.Number({
			description: "Max response bytes; excess is truncated",
			default: DEFAULT_MAX_OUTPUT_SIZE,
			minimum: MIN_OUTPUT_SIZE,
			maximum: MAX_OUTPUT_SIZE,
		}),
	),

	redirect: Type.Optional(
		Type.Union(
			[Type.Literal("follow"), Type.Literal("error"), Type.Literal("manual")],
			{
				description: "Redirect handling",
				default: "follow",
			},
		),
	),

	includeHeaders: Type.Optional(
		Type.Union(
			[
				Type.Boolean(),
				Type.Literal("none"),
				Type.Literal("safe"),
				Type.Literal("all"),
			],
			{
				description: "Response headers: safe, all/true, or none/false",
				default: "safe",
			},
		),
	),
});

export type FetchParams = Static<typeof parameters>;

export interface FetchDetails {
	url: string;
	originalUrl?: string | undefined;
	status: number;
	statusText: string;
	headers?: Record<string, string> | undefined;
	title?: string | undefined;
	bodyType: BodyType;
	markdown?: MarkdownStatus | undefined;
	size: number;
	outputSize?: number | undefined;
	returnedOutputSize?: number | undefined;
	truncated: boolean;
	previewSize?: number | undefined;
	minified: boolean;
}

export interface FetchToolDependencies {
	htmlToMarkdown?: (html: string, responseUrl: string) => MarkdownResult;
}

interface RequestOptions {
	timeout: number;
	method: NonNullable<FetchParams["method"]>;
	minify: boolean;
	markdown: boolean;
	maxOutputSize: number;
	headerMode: HeaderMode;
	redirect: RequestRedirect;
	url: URL;
}

interface ProcessedBody {
	bodyType: BodyType;
	content: string | null;
	size: number;
	outputSize: number;
	returnedOutputSize: number;
	truncated: boolean;
	minified: boolean;
	title?: string | undefined;
	markdown?: MarkdownStatus | undefined;
}

const validationError = (message: string) =>
	toolError(message, { errorType: "validation" });

const isIntegerInRange = (value: number, min: number, max: number): boolean =>
	Number.isInteger(value) && value >= min && value <= max;

const headerModeOf = (value: FetchParams["includeHeaders"]): HeaderMode => {
	if (value === true || value === "all") return "all";
	if (value === false || value === "none") return "none";
	return "safe";
};

// The schema already bounds these, but execute can be called directly (tests,
// other extensions) and Pi's validation does not reject fractional numbers.
const validate = (params: FetchParams): RequestOptions => {
	const timeout = params.timeout ?? DEFAULT_TIMEOUT;
	const maxOutputSize = params.maxOutputSize ?? DEFAULT_MAX_OUTPUT_SIZE;
	const method = params.method ?? "GET";

	if (!isIntegerInRange(timeout, MIN_TIMEOUT, MAX_TIMEOUT)) {
		throw validationError(
			`Timeout must be between ${MIN_TIMEOUT}ms and ${MAX_TIMEOUT}ms`,
		);
	}
	if (!isIntegerInRange(maxOutputSize, MIN_OUTPUT_SIZE, MAX_OUTPUT_SIZE)) {
		throw validationError(
			`maxOutputSize must be between ${MIN_OUTPUT_SIZE} and ${MAX_OUTPUT_SIZE} bytes`,
		);
	}

	let url: URL;
	try {
		url = new URL(params.url);
	} catch {
		throw validationError("Invalid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw validationError(`Unsupported URL protocol '${url.protocol}'`);
	}

	if ((method === "GET" || method === "HEAD") && params.body !== undefined) {
		throw validationError(`${method} requests cannot include a body`);
	}

	return {
		timeout,
		method,
		minify: params.minify ?? true,
		markdown: params.markdown === true,
		maxOutputSize,
		headerMode: headerModeOf(params.includeHeaders),
		redirect: params.redirect ?? "follow",
		url,
	};
};

const buildRequestInit = (
	params: FetchParams,
	options: RequestOptions,
	signal: AbortSignal,
): RequestInit => {
	const headers = buildHeaders(params.headers);
	const init: RequestInit = {
		method: options.method,
		headers,
		redirect: options.redirect,
		signal,
	};
	if (typeof params.body === "string") {
		init.body = params.body;
	} else if (params.body !== undefined) {
		init.body = JSON.stringify(params.body);
		if (!findHeaderKey(headers, "content-type")) {
			headers["Content-Type"] = "application/json";
		}
	}
	return init;
};

const cancelResponseBody = (response: Response): void => {
	try {
		// A stalled cancel must not delay the result, so it is never awaited.
		void response.body?.cancel().catch(() => undefined);
	} catch {
		// Cleanup must not replace the original failure.
	}
};

const getContentLength = (response: Response): number | undefined => {
	const header = response.headers.get("content-length");
	if (!header) return undefined;
	const parsed = Number(header);
	return Number.isFinite(parsed) ? parsed : undefined;
};

const buildResponseHeaders = (
	response: Response,
	mode: HeaderMode,
): Record<string, string> | undefined => {
	if (mode === "none") return undefined;
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		if (mode === "all" || SAFE_RESPONSE_HEADERS.has(key.toLowerCase())) {
			headers[key] = value;
		}
	});
	return headers;
};

const downloadLimitFor = (kind: ContentKind, minify: boolean): number =>
	kind === "html" || (minify && isStructuredKind(kind))
		? DEFAULT_MAX_DOWNLOAD_SIZE
		: DEFAULT_MAX_RESPONSE_SIZE;

const emptyBody = (): ProcessedBody => ({
	bodyType: "none",
	content: null,
	size: 0,
	outputSize: 0,
	returnedOutputSize: 0,
	truncated: false,
	minified: false,
});

const processBody = (
	rawBytes: Uint8Array,
	contentType: string,
	declaredKind: ContentKind,
	finalUrl: string,
	options: RequestOptions,
	deadline: Deadline,
	htmlToMarkdown: NonNullable<FetchToolDependencies["htmlToMarkdown"]>,
): ProcessedBody => {
	const kind =
		declaredKind === "unknown"
			? looksLikeText(rawBytes)
				? "text"
				: "binary"
			: declaredKind;
	const size = rawBytes.byteLength;

	if (kind === "binary") {
		if (options.markdown) debug("markdown_not_html", contentType || "(none)");
		return {
			bodyType: "binary",
			content: toBase64(rawBytes.subarray(0, DEFAULT_BINARY_PREVIEW_SIZE)),
			size,
			outputSize: 0,
			returnedOutputSize: 0,
			truncated: size > DEFAULT_BINARY_PREVIEW_SIZE,
			minified: false,
			markdown: options.markdown ? "not_html" : undefined,
		};
	}

	const text = decodeText(rawBytes, contentType, kind === "html");
	deadline.check();

	let bodyType: BodyType = "text";
	let content = text;
	let title: string | undefined;
	let markdown: MarkdownStatus | undefined;

	if (kind === "html" && options.markdown) {
		try {
			const converted = htmlToMarkdown(text, finalUrl);
			content = converted.content;
			title = converted.title;
			bodyType = "markdown";
			markdown = "converted";
		} catch (error) {
			debug(
				"markdown_failed",
				error instanceof Error ? error.name : typeof error,
			);
			markdown = "failed";
			title = extractTitle(text);
		}
		deadline.check();
	} else {
		if (kind === "html") title = extractTitle(text);
		if (options.markdown) {
			debug("markdown_not_html", contentType || "(none)");
			markdown = "not_html";
		}
	}

	let minified = false;
	if (options.minify && bodyType === "text" && content) {
		const result = minifyText(content, contentType);
		deadline.check();
		content = result.content;
		minified = result.minified;
	}

	const limited = truncateText(content, options.maxOutputSize);
	return {
		bodyType,
		content: limited.content,
		size,
		outputSize: limited.outputSize,
		returnedOutputSize: limited.returnedSize,
		truncated: limited.truncated,
		minified,
		title,
		markdown,
	};
};

const MARKDOWN_NOTES: Record<Exclude<MarkdownStatus, "converted">, string> = {
	failed: "[Markdown conversion failed; returning the HTML instead.]",
	not_html:
		"[Markdown was requested, but the response is not HTML; returning it unchanged.]",
};

interface ResultTextInput {
	status: number;
	statusText: string;
	finalUrl: string;
	headers: Record<string, string> | undefined;
	body: ProcessedBody;
}

const buildResultText = ({
	status,
	statusText,
	finalUrl,
	headers,
	body,
}: ResultTextInput): string => {
	let text = `HTTP ${status} ${statusText}\nURL: ${finalUrl}\n`;
	text += headers ? `Headers: ${JSON.stringify(headers, null, 2)}\n\n` : "\n";

	if (body.markdown && body.markdown !== "converted") {
		text += `${MARKDOWN_NOTES[body.markdown]}\n`;
	}

	if (!body.content || body.bodyType === "none") {
		text += "Response: (no response body)";
	} else if (body.bodyType === "binary") {
		text += `Response (binary data, size ${body.size} bytes, base64 preview):\n${body.content}`;
	} else if (body.bodyType === "markdown") {
		text += `Response (HTML converted to markdown):\n${body.content}`;
	} else {
		text += `Response:\n${body.content}`;
	}

	if (body.truncated) {
		text +=
			body.bodyType === "binary"
				? `\n\n[Response truncated: downloaded ${body.size} bytes; showing a ${Math.min(body.size, DEFAULT_BINARY_PREVIEW_SIZE)}-byte preview.]`
				: `\n\n[Response truncated: showing up to the configured output limit from ${body.outputSize} output bytes.]`;
	}
	return text;
};

export default (dependencies: FetchToolDependencies = {}) => {
	const htmlToMarkdown = dependencies.htmlToMarkdown ?? convertHtmlToMarkdown;

	return {
		name: "fetch",
		label: "Web fetch",
		description: "Fetch a URL with an HTTP request",
		promptSnippet: "Fetch a URL with HTTP",
		parameters,

		async execute(
			_toolCallId: string,
			params: FetchParams,
			signal: AbortSignal | undefined,
		): Promise<AgentToolResult<FetchDetails>> {
			const options = validate(params);
			const originalUrl = options.url.toString();
			const deadline = createDeadline(signal, options.timeout);
			let response: Response | undefined;
			let bodyHandled = false;

			try {
				response = await fetch(
					originalUrl,
					buildRequestInit(params, options, deadline.signal),
				);
				deadline.check();

				const status = response.status;
				const finalUrl = response.url || originalUrl;
				const contentType = response.headers.get("content-type") ?? "";
				const kind = classifyContentType(contentType);
				const isNoBodyResponse =
					options.method === "HEAD" || status === 204 || status === 304;

				let body: ProcessedBody;
				if (isNoBodyResponse) {
					bodyHandled = true;
					cancelResponseBody(response);
					body = emptyBody();
				} else {
					const downloadLimit = downloadLimitFor(kind, options.minify);
					const declaredLength = getContentLength(response);
					if (declaredLength !== undefined && declaredLength > downloadLimit) {
						throw toolError(
							`Response size (${declaredLength} bytes) exceeds maximum allowed size (${downloadLimit} bytes)`,
							{
								errorType: "size_limit",
								maxSize: downloadLimit,
								actualSize: declaredLength,
							},
						);
					}
					// From here the reader owns the body and cancels it on failure.
					bodyHandled = true;
					const rawBytes = await readResponseWithLimit(
						response,
						downloadLimit,
						deadline.signal,
					);
					deadline.check();
					body = processBody(
						rawBytes,
						contentType,
						kind,
						finalUrl,
						options,
						deadline,
						htmlToMarkdown,
					);
				}

				const headers = buildResponseHeaders(response, options.headerMode);
				const safeFinalUrl = redactUrl(finalUrl);
				const text = buildResultText({
					status,
					statusText: response.statusText,
					finalUrl: safeFinalUrl,
					headers,
					body,
				});
				deadline.check();

				const isBinary = body.bodyType === "binary";
				return {
					content: [{ type: "text", text }],
					// The body itself lives only in `content`. Pi persists details in
					// the session file, so repeating the body there would double the
					// stored size of every fetch.
					details: {
						url: safeFinalUrl,
						originalUrl:
							finalUrl !== originalUrl ? redactUrl(originalUrl) : undefined,
						status,
						statusText: response.statusText,
						headers,
						title: body.title,
						bodyType: body.bodyType,
						markdown: body.markdown,
						size: body.size,
						outputSize: isBinary ? undefined : body.outputSize,
						returnedOutputSize: isBinary ? undefined : body.returnedOutputSize,
						truncated: body.truncated,
						previewSize: isBinary
							? Math.min(body.size, DEFAULT_BINARY_PREVIEW_SIZE)
							: undefined,
						minified: body.minified,
					},
				};
			} catch (error) {
				if (response && !bodyHandled) cancelResponseBody(response);
				const normalized = normalizeError(
					error,
					originalUrl,
					options.timeout,
					deadline.cause(),
				);
				debug("request_failed", normalized.errorType);
				throw Object.assign(
					new Error(
						`Error fetching ${redactUrl(params.url)}: ${normalized.message}`,
					),
					normalized,
				);
			}
		},
	};
};
