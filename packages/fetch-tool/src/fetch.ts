import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import domino from "@mixmark-io/domino";
import TurndownService from "turndown";
import { Type } from "typebox";
import {
	DEFAULT_BINARY_PREVIEW_SIZE,
	DEFAULT_MAX_DOWNLOAD_SIZE,
	DEFAULT_MAX_OUTPUT_SIZE,
	DEFAULT_MAX_RESPONSE_SIZE,
	DEFAULT_TIMEOUT,
} from "./constants.ts";
import { normalizeError } from "./error.ts";
import { buildHeaders, findHeaderKey } from "./headers.ts";
import { minifyText } from "./minify.ts";
import { createTimeoutSignal, type FetchBody } from "./request.ts";
import { readResponseWithLimit } from "./response.ts";

type BodyType = "binary" | "markdown" | "none" | "text";
type HeaderMode = "all" | "none" | "safe";
interface FetchParams {
	body?: FetchBody;
	headers?: Record<string, string>;
	includeHeaders?: boolean | HeaderMode;
	markdown?: boolean;
	maxOutputSize?: number;
	method?: "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
	minify?: boolean;
	redirect?: RequestRedirect;
	timeout?: number;
	url: string;
}

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

const turndownService = new TurndownService();
turndownService.remove("script");
turndownService.remove("style");

const removeNodes = (root: Document, selectors: string[]): void => {
	for (const selector of selectors) {
		const nodes = root.querySelectorAll(selector);

		for (let i = nodes.length - 1; i >= 0; i--) {
			const node = nodes.item(i);
			node.parentNode?.removeChild(node);
		}
	}
};

const makeUrlsAbsolute = (document: Document, baseUrl: string): void => {
	for (const [selector, attribute] of [
		["a[href]", "href"],
		["img[src]", "src"],
	] as const) {
		const nodes = document.querySelectorAll(selector);
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes.item(index);
			const value = node.getAttribute(attribute);
			if (!value || value.startsWith("#")) {
				continue;
			}

			try {
				const absolute = new URL(value, baseUrl);
				const allowedProtocols =
					attribute === "href"
						? new Set(["http:", "https:", "mailto:", "tel:"])
						: new Set(["http:", "https:"]);
				if (allowedProtocols.has(absolute.protocol)) {
					node.setAttribute(attribute, absolute.toString());
				} else {
					node.removeAttribute(attribute);
				}
			} catch {
				node.removeAttribute(attribute);
			}
		}
	}
};

const findMainContent = (document: Document): Element | null => {
	const selectors = [
		".devsite-article-body",
		"article.main-content",
		"article",
		"main",
		"[role='main']",
		".article-body",
		".entry-content",
		".post-content",
		"#content",
		".content",
	];

	for (const selector of selectors) {
		const candidates = document.querySelectorAll(selector);
		let best: Element | null = null;
		let bestScore = 0;
		for (let index = 0; index < candidates.length; index++) {
			const candidate = candidates.item(index);
			const textLength = (candidate.textContent ?? "").trim().length;
			let linkLength = 0;
			const links = candidate.querySelectorAll("a");
			for (let linkIndex = 0; linkIndex < links.length; linkIndex++) {
				linkLength += (links.item(linkIndex).textContent ?? "").trim().length;
			}
			const score = textLength - linkLength * 0.75;
			if (score > bestScore) {
				best = candidate;
				bestScore = score;
			}
		}
		if (best) {
			return best;
		}
	}

	return document.body;
};

const convertHtmlToMarkdown = (
	html: string,
	baseUrl: string,
): { content: string; title?: string } => {
	const document = domino.createDocument(html, true);

	removeNodes(document, [
		"script",
		"style",
		"noscript",
		"template",
		"svg",
		"header",
		"footer",
		"nav",
		"aside",
		"form",
		"dialog",
		"devsite-header",
		"devsite-book-nav",
		"devsite-toc",
		".devsite-sidebar",
		".devsite-banner",
		".devsite-article-meta",
		".devsite-actions",
		".nocontent",
		"[hidden]",
		"[data-nosnippet]",
		"[aria-hidden='true']",
		".advertisement",
		".cookie-banner",
		".newsletter-signup",
		".social-share",
	]);

	makeUrlsAbsolute(document, baseUrl);
	const contentNode = findMainContent(document);

	const htmlToConvert =
		contentNode?.innerHTML || document.body?.innerHTML || html;

	const content = turndownService
		.turndown(htmlToConvert)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const title = document.title.trim() || undefined;
	return title ? { content, title } : { content };
};

const uint8ToBase64 = (bytes: Uint8Array): string => {
	const chunkSize = 0x8000;

	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}

	return btoa(binary);
};

const validateUrl = (url: string): URL => {
	const urlObj = new URL(url);

	if (!["http:", "https:"].includes(urlObj.protocol)) {
		throw new Error(`Unsupported URL protocol '${urlObj.protocol}'`);
	}

	return urlObj;
};

const addRequestBody = (
	fetchOptions: RequestInit,
	headers: Record<string, string>,
	body?: FetchBody,
): void => {
	if (body === undefined) {
		return;
	}

	if (typeof body === "string") {
		fetchOptions.body = body;
		return;
	}

	fetchOptions.body = JSON.stringify(body);

	const contentTypeKey = findHeaderKey(headers, "content-type");

	if (!contentTypeKey) {
		headers["Content-Type"] = "application/json";
	}
};

const textEncoder = new TextEncoder();
const getStringByteLength = (value: string): number => {
	return textEncoder.encode(value).byteLength;
};

const cancelResponseBody = (response: Response): void => {
	try {
		const cancellation = response.body?.cancel();
		if (cancellation) {
			void Promise.resolve(cancellation).catch(() => undefined);
		}
	} catch {
		// Cleanup must not replace the original failure.
	}
};

const truncateText = (
	value: string,
	maxBytes: number,
): {
	content: string;
	outputSize: number;
	returnedSize: number;
	truncated: boolean;
} => {
	const encoded = textEncoder.encode(value);
	if (encoded.byteLength <= maxBytes) {
		return {
			content: value,
			outputSize: encoded.byteLength,
			returnedSize: encoded.byteLength,
			truncated: false,
		};
	}

	let end = Math.min(maxBytes, encoded.byteLength);
	let content = "";
	const decoder = new TextDecoder("utf-8", { fatal: true });
	while (end > 0) {
		try {
			content = decoder.decode(encoded.subarray(0, end));
			break;
		} catch {
			end--;
		}
	}
	return {
		content,
		outputSize: encoded.byteLength,
		returnedSize: getStringByteLength(content),
		truncated: true,
	};
};

const getCharset = (contentType: string, bytes: Uint8Array): string => {
	const headerMatch = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
	if (headerMatch?.[1]) {
		return headerMatch[1];
	}

	if (contentType.includes("html")) {
		const prefix = new TextDecoder("windows-1252").decode(
			bytes.subarray(0, 4096),
		);
		const metaMatch = prefix.match(
			/<meta\s+[^>]*(?:charset\s*=\s*["']?([^\s"'/>;]+)|content\s*=\s*["'][^"']*charset=([^\s"';]+))/i,
		);
		return metaMatch?.[1] ?? metaMatch?.[2] ?? "utf-8";
	}

	return "utf-8";
};

const decodeText = (bytes: Uint8Array, contentType: string): string => {
	try {
		return new TextDecoder(getCharset(contentType, bytes)).decode(bytes);
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError")
			throw error;
		return new TextDecoder().decode(bytes);
	}
};

const getContentLength = (response: Response): number | undefined => {
	const header = response.headers.get("content-length");
	if (!header) {
		return undefined;
	}

	const parsed = Number(header);
	return Number.isFinite(parsed) ? parsed : undefined;
};

const buildResultText = (
	status: number,
	statusText: string,
	finalUrl: string,
	responseHeaders: Record<string, string> | undefined,
	bodyType: BodyType,
	bodyContent: string | null,
	bodySize: number,
	truncated: boolean,
	outputSize: number,
): string => {
	let resultText = `HTTP ${status} ${statusText}\n`;
	resultText += `URL: ${finalUrl}\n`;

	if (responseHeaders) {
		resultText += `Headers: ${JSON.stringify(responseHeaders, null, 2)}\n\n`;
	} else {
		resultText += `\n`;
	}

	if (!bodyContent || bodyType === "none") {
		resultText += `Response: (no response body)`;
	} else {
		switch (bodyType) {
			case "binary": {
				resultText += `Response (binary data, size ${bodySize} bytes, base64 preview):\n${bodyContent}`;
				break;
			}

			case "markdown":
				resultText += `Response (HTML converted to markdown):\n${bodyContent}`;
				break;

			default:
				resultText += `Response:\n${bodyContent}`;
				break;
		}
	}

	if (truncated) {
		resultText +=
			bodyType === "binary"
				? `\n\n[Response truncated: downloaded ${bodySize} bytes; showing a ${outputSize}-byte preview.]`
				: `\n\n[Response truncated: showing up to the configured output limit from ${outputSize} output bytes.]`;
	}

	return resultText;
};

const buildResponseHeaders = (
	response: Response,
	mode: HeaderMode,
): Record<string, string> | undefined => {
	if (mode === "none") {
		return undefined;
	}
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		if (mode === "all" || SAFE_RESPONSE_HEADERS.has(key.toLowerCase())) {
			headers[key] = value;
		}
	});
	return headers;
};

export default () => ({
	name: "fetch",
	label: "Web fetch",
	description: "Fetch a URL with an HTTP request",
	promptSnippet: "Fetch a URL with HTTP",

	parameters: Type.Object({
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
				minimum: 100,
				maximum: 2_147_483_647,
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
				minimum: 1024,
				maximum: DEFAULT_MAX_RESPONSE_SIZE,
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
	}),

	async execute(
		_toolCallId: string,
		params: FetchParams,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<unknown>> {
		const timeout = params.timeout ?? DEFAULT_TIMEOUT;
		const method = params.method ?? "GET";
		const minify = params.minify ?? true;
		const maxOutputSize = params.maxOutputSize ?? DEFAULT_MAX_OUTPUT_SIZE;
		const headerMode: HeaderMode =
			params.includeHeaders === true || params.includeHeaders === "all"
				? "all"
				: params.includeHeaders === false || params.includeHeaders === "none"
					? "none"
					: "safe";

		if (
			!Number.isFinite(timeout) ||
			!Number.isInteger(timeout) ||
			timeout < 100 ||
			timeout > 2_147_483_647
		) {
			throw Object.assign(
				new Error("Timeout must be between 100ms and 2147483647ms"),
				{ errorType: "validation" },
			);
		}
		if (
			!Number.isFinite(maxOutputSize) ||
			!Number.isInteger(maxOutputSize) ||
			maxOutputSize < 1024 ||
			maxOutputSize > DEFAULT_MAX_RESPONSE_SIZE
		) {
			throw Object.assign(
				new Error(
					`maxOutputSize must be between 1024 and ${DEFAULT_MAX_RESPONSE_SIZE} bytes`,
				),
				{ errorType: "validation" },
			);
		}

		let urlObj: URL;
		try {
			urlObj = validateUrl(params.url);
		} catch (error) {
			throw Object.assign(
				new Error(error instanceof Error ? error.message : "Invalid URL"),
				{ errorType: "validation" },
			);
		}

		if ((method === "GET" || method === "HEAD") && params.body !== undefined) {
			throw Object.assign(
				new Error(`${method} requests cannot include a body`),
				{ errorType: "validation" },
			);
		}
		const headers = buildHeaders(params.headers);
		const originalUrl = urlObj.toString();
		const deadline = Date.now() + timeout;
		const timeoutContext = createTimeoutSignal(signal, timeout);
		const checkDeadline = () => {
			timeoutContext.signal?.throwIfAborted();
			if (Date.now() >= deadline) {
				throw Object.assign(
					new DOMException("Request deadline exceeded", "AbortError"),
					{ errorType: "timeout" },
				);
			}
		};

		let response: Response | undefined;
		let bodyOwned = false;
		let bodyCleanupAttempted = false;

		try {
			const fetchOptions: RequestInit = {
				method,
				headers,
				redirect: params.redirect ?? "follow",
				...(timeoutContext.signal ? { signal: timeoutContext.signal } : {}),
			};
			addRequestBody(
				fetchOptions,
				headers,
				params.body as FetchBody | undefined,
			);
			response = await fetch(originalUrl, fetchOptions);
			checkDeadline();

			const status = response.status;
			const statusText = response.statusText;
			const responseHeaders = buildResponseHeaders(response, headerMode);
			const finalUrl = response.url || originalUrl;
			const contentType = (
				response.headers.get("content-type") || ""
			).toLowerCase();
			const isHtmlResponse = contentType.includes("text/html");
			const isMinifiableResponse =
				contentType.includes("json") || contentType.includes("xml");
			const isNoBodyResponse =
				method === "HEAD" || status === 204 || status === 304;
			const downloadLimit =
				(isHtmlResponse || (minify && isMinifiableResponse)) &&
				!isNoBodyResponse
					? Math.max(DEFAULT_MAX_RESPONSE_SIZE, DEFAULT_MAX_DOWNLOAD_SIZE)
					: DEFAULT_MAX_RESPONSE_SIZE;

			const declaredLength = getContentLength(response);
			if (declaredLength !== undefined && declaredLength > downloadLimit) {
				bodyCleanupAttempted = true;
				cancelResponseBody(response);
				throw Object.assign(
					new Error(
						`Response size (${declaredLength} bytes) exceeds maximum allowed size (${downloadLimit} bytes)`,
					),
					{
						errorType: "size_limit",
						maxSize: downloadLimit,
						actualSize: declaredLength,
					},
				);
			}

			let bodyType: BodyType = "text";
			let bodyContent: string | null = null;
			let bodySize = 0;
			let bodyOutputSize = 0;
			let returnedOutputSize = 0;
			let minified = false;
			let truncated = false;
			let pageTitle: string | undefined;

			if (isNoBodyResponse) {
				bodyType = "none";
				bodyCleanupAttempted = true;
				cancelResponseBody(response);
			} else {
				bodyOwned = true;
				const rawBytes = await readResponseWithLimit(
					response,
					downloadLimit,
					timeoutContext.signal,
				);
				bodySize = rawBytes.byteLength;

				checkDeadline();
				if (isHtmlResponse) {
					const html = decodeText(rawBytes, contentType);
					checkDeadline();
					pageTitle =
						domino.createDocument(html, true).title.trim() || undefined;
					const shouldConvertToMarkdown = params.markdown === true;

					if (shouldConvertToMarkdown) {
						try {
							checkDeadline();
							const converted = convertHtmlToMarkdown(html, finalUrl);
							checkDeadline();
							bodyContent = converted.content;
							pageTitle = converted.title;
							bodyType = "markdown";
						} catch (_error) {
							bodyContent = html;
						}
					} else {
						bodyContent = html;
					}
				} else if (
					isMinifiableResponse ||
					contentType.startsWith("text/") ||
					contentType.includes("application/javascript") ||
					contentType.includes("application/css")
				) {
					bodyContent = decodeText(rawBytes, contentType);
				} else {
					bodyContent = uint8ToBase64(
						rawBytes.subarray(0, DEFAULT_BINARY_PREVIEW_SIZE),
					);
					bodyType = "binary";
					truncated = rawBytes.byteLength > DEFAULT_BINARY_PREVIEW_SIZE;
				}

				checkDeadline();
				if (minify && bodyType === "text" && bodyContent) {
					const minifyResult = minifyText(bodyContent, contentType);
					checkDeadline();
					bodyContent = minifyResult.content;
					minified = minifyResult.minified;
				}

				if (bodyType !== "binary" && bodyContent) {
					const limited = truncateText(bodyContent, maxOutputSize);
					bodyContent = limited.content;
					bodyOutputSize = limited.outputSize;
					returnedOutputSize = limited.returnedSize;
					truncated = limited.truncated;
				}
			}

			const resultText = buildResultText(
				status,
				statusText,
				finalUrl,
				responseHeaders,
				bodyType,
				bodyContent,
				bodySize,
				truncated,
				bodyType === "binary"
					? Math.min(bodySize, DEFAULT_BINARY_PREVIEW_SIZE)
					: bodyOutputSize,
			);
			checkDeadline();

			return {
				content: [
					{
						type: "text",
						text: resultText,
					},
				],

				details: {
					url: finalUrl,

					originalUrl: finalUrl !== originalUrl ? originalUrl : undefined,

					status,
					statusText,

					headers: responseHeaders,

					title: pageTitle,

					bodyType,

					body:
						bodyType !== "binary" && bodyType !== "none"
							? bodyContent
							: undefined,

					size: bodyType === "none" ? 0 : bodySize,

					outputSize: bodyType === "binary" ? undefined : bodyOutputSize,

					returnedOutputSize:
						bodyType === "binary" ? undefined : returnedOutputSize,

					truncated,

					previewSize:
						bodyType === "binary"
							? Math.min(bodySize, DEFAULT_BINARY_PREVIEW_SIZE)
							: undefined,

					minified,
				},
			};
		} catch (error) {
			if (response && !bodyOwned && !bodyCleanupAttempted) {
				bodyCleanupAttempted = true;
				cancelResponseBody(response);
			}
			const normalized = normalizeError(
				error,
				originalUrl,
				timeout,
				timeoutContext.getAbortCause(),
			);
			throw Object.assign(
				new Error(`Error fetching ${params.url}: ${normalized.message}`),
				normalized,
			);
		} finally {
			timeoutContext.cleanup();
		}
	},
});
