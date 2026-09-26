import { debug } from "./debug.ts";

const META_SNIFF_BYTES = 4096;

export const getCharset = (
	contentType: string,
	bytes: Uint8Array,
	isHtml: boolean,
): string => {
	const headerMatch = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
	if (headerMatch?.[1]) return headerMatch[1];

	if (isHtml) {
		// windows-1252 maps every byte to a character, so the ASCII meta tag
		// is readable whatever the real encoding turns out to be.
		const prefix = new TextDecoder("windows-1252").decode(
			bytes.subarray(0, META_SNIFF_BYTES),
		);
		const metaMatch = prefix.match(
			/<meta\s+[^>]*(?:charset\s*=\s*["']?([^\s"'/>;]+)|content\s*=\s*["'][^"']*charset=([^\s"';]+))/i,
		);
		return metaMatch?.[1] ?? metaMatch?.[2] ?? "utf-8";
	}

	return "utf-8";
};

// Code points for bytes 0x80 to 0x9F in the WHATWG windows-1252 index. The
// five undefined bytes map to their own C1 control code point, as browsers do.
const WINDOWS_1252_HIGH = [
	0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030,
	0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d,
	0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e,
	0x178,
];

// Some Node releases (22.x among them) decode windows-1252 as plain Latin-1,
// turning the euro sign, curly quotes, and dashes into invisible C1 controls.
// Pages labelled latin1/iso-8859-1/ascii also land here, because WHATWG maps
// those labels to windows-1252.
const nativeWindows1252IsCorrect =
	new TextDecoder("windows-1252").decode(new Uint8Array([0x80])) === "€";

export const decodeWindows1252 = (bytes: Uint8Array): string =>
	Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		.toString("latin1")
		.replace(/[\x80-\x9f]/g, (character) =>
			String.fromCharCode(
				WINDOWS_1252_HIGH[character.charCodeAt(0) - 0x80] ??
					character.charCodeAt(0),
			),
		);

export const decodeText = (
	bytes: Uint8Array,
	contentType: string,
	isHtml: boolean,
): string => {
	const charset = getCharset(contentType, bytes, isHtml);
	try {
		const decoder = new TextDecoder(charset);
		if (decoder.encoding === "windows-1252" && !nativeWindows1252IsCorrect)
			return decodeWindows1252(bytes);
		return decoder.decode(bytes);
	} catch {
		// TextDecoder throws RangeError for labels it does not know. UTF-8 is
		// the most likely real encoding and never throws in replacement mode.
		debug("charset_unsupported", charset.replace(/[^\w.:-]/g, "").slice(0, 40));
		return new TextDecoder().decode(bytes);
	}
};

const textEncoder = new TextEncoder();

export interface TruncatedText {
	content: string;
	outputSize: number;
	returnedSize: number;
	truncated: boolean;
}

export const truncateText = (
	value: string,
	maxBytes: number,
): TruncatedText => {
	const outputSize = Buffer.byteLength(value, "utf8");
	if (outputSize <= maxBytes) {
		return {
			content: value,
			outputSize,
			returnedSize: outputSize,
			truncated: false,
		};
	}

	// encodeInto never writes a partial character, so `read` marks the longest
	// prefix whose UTF-8 form fits. That avoids both a replacement character at
	// the cut and encoding the whole (possibly 32 MiB) string.
	const { read, written } = textEncoder.encodeInto(
		value,
		new Uint8Array(maxBytes),
	);
	return {
		content: value.slice(0, read),
		outputSize,
		returnedSize: written,
		truncated: true,
	};
};

export const toBase64 = (bytes: Uint8Array): string =>
	Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
		"base64",
	);
