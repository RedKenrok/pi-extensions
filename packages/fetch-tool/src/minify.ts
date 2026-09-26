import { classifyContentType } from "./content-type.ts";

export interface MinifyResult {
	content: string;
	minified: boolean;
}

interface HtmlToken {
	type: "markup" | "text";
	value: string;
}

const HTML_WHITESPACE_PRESERVING_ELEMENTS = new Set([
	"pre",
	"script",
	"style",
	"textarea",
]);

const HTML_PHRASING_ELEMENTS = new Set([
	"a",
	"b",
	"button",
	"code",
	"em",
	"i",
	"label",
	"small",
	"span",
	"strong",
	"sub",
	"sup",
]);

const HTML_VOID_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

const HTML_RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea"]);

const findMarkupEnd = (value: string, start: number): number => {
	if (value.startsWith("<!--", start)) {
		const end = value.indexOf("-->", start + 4);
		return end === -1 ? -1 : end + 3;
	}

	if (value.startsWith("<![CDATA[", start)) {
		const end = value.indexOf("]]>", start + 9);
		return end === -1 ? -1 : end + 3;
	}

	if (value.startsWith("<?", start)) {
		const end = value.indexOf("?>", start + 2);
		return end === -1 ? -1 : end + 2;
	}

	let quote: '"' | "'" | null = null;
	let bracketDepth = 0;

	for (let index = start + 1; index < value.length; index++) {
		const character = value[index];

		if (quote) {
			if (character === quote) {
				quote = null;
			}
			continue;
		}

		if (character === '"' || character === "'") {
			quote = character;
		} else if (character === "[") {
			bracketDepth++;
		} else if (character === "]" && bracketDepth > 0) {
			bracketDepth--;
		} else if (character === ">" && bracketDepth === 0) {
			return index + 1;
		}
	}

	return -1;
};

const minifyXml = (value: string): string | undefined => {
	let position = 0;
	while (position < value.length) {
		const markupStart = value.indexOf("<", position);
		if (markupStart === -1) break;
		const markupEnd = findMarkupEnd(value, markupStart);
		if (markupEnd === -1) return undefined;
		position = markupEnd;
	}
	// Without a schema, even whitespace-only text between empty elements may
	// be significant. Only trim outside the document; preserve all inner text.
	return value.trim();
};

// Validate with the native parser, but never serialize its (potentially rounded)
// values. Removing only whitespace outside strings preserves every JSON lexeme.
const minifyJson = (value: string): string | undefined => {
	try {
		JSON.parse(value);
	} catch {
		return undefined;
	}
	const chunks: string[] = [];
	let start = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
		} else if (character === '"') {
			inString = true;
		} else if (
			character === " " ||
			character === "\t" ||
			character === "\r" ||
			character === "\n"
		) {
			if (index > start) chunks.push(value.slice(start, index));
			start = index + 1;
		}
	}
	chunks.push(value.slice(start));
	return chunks.join("");
};

const minifyNdjson = (value: string): string | undefined => {
	const lines = value.split(/\r?\n/);
	const minifiedLines: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed) {
			const minified = minifyJson(trimmed);
			if (minified === undefined) return undefined;
			minifiedLines.push(minified);
		}
	}
	return minifiedLines.length > 0 ? minifiedLines.join("\n") : undefined;
};

const getHtmlTag = (
	markup: string,
): { name: string; closing: boolean; selfClosing: boolean } | undefined => {
	const match = markup.match(/^<\s*(\/?)\s*([a-z][\w:-]*)/i);
	if (!match) {
		return undefined;
	}
	const name = match[2];
	if (!name) {
		return undefined;
	}

	return {
		name: name.toLowerCase(),
		closing: match[1] === "/",
		selfClosing: /\/\s*>$/.test(markup),
	};
};

const tokenizeHtml = (value: string): HtmlToken[] | undefined => {
	const tokens: HtmlToken[] = [];
	const lowerValue = value.toLowerCase();
	let position = 0;
	let rawTextElement: string | undefined;

	while (position < value.length) {
		let markupStart: number;
		if (rawTextElement) {
			const closingPrefix = `</${rawTextElement}`;
			markupStart = lowerValue.indexOf(closingPrefix, position);
			while (
				markupStart !== -1 &&
				!/[\s>]/.test(value[markupStart + closingPrefix.length] ?? "")
			) {
				markupStart = lowerValue.indexOf(
					closingPrefix,
					markupStart + closingPrefix.length,
				);
			}
		} else {
			markupStart = value.indexOf("<", position);
		}

		if (markupStart === -1) {
			tokens.push({ type: "text", value: value.slice(position) });
			break;
		}

		if (markupStart > position) {
			tokens.push({ type: "text", value: value.slice(position, markupStart) });
		}

		const markupEnd = findMarkupEnd(value, markupStart);
		if (markupEnd === -1) {
			return undefined;
		}

		const markup = value.slice(markupStart, markupEnd);
		tokens.push({ type: "markup", value: markup });
		const tag = getHtmlTag(markup);
		if (rawTextElement && tag?.closing && tag.name === rawTextElement) {
			rawTextElement = undefined;
		} else if (
			!rawTextElement &&
			tag &&
			!tag.closing &&
			!tag.selfClosing &&
			HTML_RAW_TEXT_ELEMENTS.has(tag.name)
		) {
			rawTextElement = tag.name;
		}
		position = markupEnd;
	}

	return tokens;
};

const isRemovableHtmlComment = (value: string): boolean => {
	return (
		value.startsWith("<!--") &&
		!/^<!--\s*\[if\b/i.test(value) &&
		!/<!\[endif\]\s*-->$/i.test(value)
	);
};

const minifyHtml = (value: string): string | undefined => {
	const tokens = tokenizeHtml(value);
	if (!tokens) {
		return undefined;
	}

	const output: HtmlToken[] = [];
	const openElements: string[] = [];

	for (const token of tokens) {
		const inSensitiveElement = openElements.some((element) =>
			HTML_WHITESPACE_PRESERVING_ELEMENTS.has(element),
		);

		if (token.type === "text") {
			output.push({
				type: "text",
				value: inSensitiveElement
					? token.value
					: token.value.replace(/\s+/g, " "),
			});
			continue;
		}

		if (isRemovableHtmlComment(token.value)) {
			continue;
		}

		output.push(token);
		const tag = getHtmlTag(token.value);
		if (!tag) {
			continue;
		}

		if (tag.closing) {
			const matchingIndex = openElements.lastIndexOf(tag.name);
			if (matchingIndex !== -1) {
				openElements.length = matchingIndex;
			}
		} else if (!tag.selfClosing && !HTML_VOID_ELEMENTS.has(tag.name)) {
			openElements.push(tag.name);
		}
	}

	return output
		.map((token, index) => {
			if (token.type !== "text" || token.value !== " ") {
				return token.value;
			}

			const previousToken = output[index - 1];
			const nextToken = output[index + 1];
			const previousTag =
				previousToken?.type === "markup"
					? getHtmlTag(previousToken.value)
					: undefined;
			const nextTag =
				nextToken?.type === "markup" ? getHtmlTag(nextToken.value) : undefined;
			const separatesSensitiveSiblings =
				previousTag?.closing === true &&
				HTML_PHRASING_ELEMENTS.has(previousTag.name) &&
				nextTag?.closing === false &&
				HTML_PHRASING_ELEMENTS.has(nextTag.name);

			return separatesSensitiveSiblings ? " " : "";
		})
		.join("")
		.trim();
};

export const minifyText = (
	content: string,
	contentType: string,
): MinifyResult => {
	const trimmed = content.trim();
	const kind = classifyContentType(contentType);
	const result = (minified: string | undefined): MinifyResult | undefined =>
		minified === undefined
			? undefined
			: { content: minified, minified: minified.length < content.length };

	// Each format falls through to the next candidate when it does not parse,
	// so a mislabeled body is still returned unchanged rather than mangled.
	return (
		(kind === "ndjson" ? result(minifyNdjson(content)) : undefined) ??
		(kind === "json" || trimmed.startsWith("{") || trimmed.startsWith("[")
			? result(minifyJson(trimmed))
			: undefined) ??
		(kind === "xml" || trimmed.startsWith("<?xml")
			? result(minifyXml(content))
			: undefined) ??
		(kind === "html" ? result(minifyHtml(content)) : undefined) ?? {
			content,
			minified: false,
		}
	);
};
