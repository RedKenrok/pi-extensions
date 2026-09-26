export type ContentKind =
	| "binary"
	| "html"
	| "json"
	| "ndjson"
	| "text"
	| "unknown"
	| "xml";

// Textual media types outside text/* that are still worth showing as text
// instead of a base64 preview.
const TEXTUAL_APPLICATION_TYPES = new Set([
	"application/ecmascript",
	"application/graphql",
	"application/javascript",
	"application/sql",
	"application/toml",
	"application/x-javascript",
	"application/x-sh",
	"application/x-www-form-urlencoded",
	"application/x-yaml",
	"application/yaml",
]);

const NDJSON_SUBTYPES = new Set([
	"ndjson",
	"x-ndjson",
	"jsonl",
	"x-jsonl",
	"jsonlines",
	"x-jsonlines",
]);

export const mediaType = (contentType: string): string =>
	(contentType.split(";")[0] ?? "").trim().toLowerCase();

/**
 * Single source of truth for how a Content-Type is treated. Download limits,
 * decoding, minification, and Markdown conversion all branch on this, so they
 * can never disagree about the same response.
 */
export const classifyContentType = (contentType: string): ContentKind => {
	const type = mediaType(contentType);
	if (!type) return "unknown";
	const [top, subtype = ""] = type.split("/");
	if (type === "text/html") return "html";
	if ((top === "application" || top === "text") && NDJSON_SUBTYPES.has(subtype))
		return "ndjson";
	if (
		((top === "application" || top === "text") && subtype === "json") ||
		subtype.endsWith("+json")
	)
		return "json";
	if (
		((top === "application" || top === "text") && subtype === "xml") ||
		subtype.endsWith("+xml")
	)
		return "xml";
	if (top === "text" || TEXTUAL_APPLICATION_TYPES.has(type)) return "text";
	return "binary";
};

export const isStructuredKind = (kind: ContentKind): boolean =>
	kind === "json" || kind === "ndjson" || kind === "xml";

const SNIFF_BYTES = 4096;

/**
 * Servers that omit Content-Type still often send plain text or JSON. Treat
 * the body as text when its prefix is valid UTF-8 without NUL or other C0
 * control bytes that ordinary text never contains.
 */
export const looksLikeText = (bytes: Uint8Array): boolean => {
	const prefix = bytes.subarray(0, SNIFF_BYTES);
	for (const byte of prefix) {
		if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b))
			return false;
	}
	try {
		// Streaming mode tolerates a multi-byte character cut by the prefix.
		new TextDecoder("utf-8", { fatal: true }).decode(prefix, { stream: true });
		return true;
	} catch {
		return false;
	}
};
