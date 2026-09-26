import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decodeWindows1252,
	getCharset,
	toBase64,
	truncateText,
} from "../src/text.ts";

describe("truncateText", () => {
	it("returns short text untouched", () => {
		assert.deepEqual(truncateText("héllo", 10), {
			content: "héllo",
			outputSize: 6,
			returnedSize: 6,
			truncated: false,
		});
	});

	it("never splits a multi-byte character", () => {
		const result = truncateText("aé🙂b", 4);
		assert.equal(result.content, "aé");
		assert.equal(result.returnedSize, 3);
		assert.equal(result.outputSize, 8);
		assert.equal(result.truncated, true);
	});

	it("counts a lone surrogate as the three-byte replacement it encodes to", () => {
		const result = truncateText("\ud800abc", 4);
		assert.equal(result.content, "\ud800a");
		assert.equal(result.returnedSize, 4);
	});
});

describe("getCharset", () => {
	const bytes = (text: string) => new TextEncoder().encode(text);

	it("prefers the header, then an HTML meta tag, then UTF-8", () => {
		assert.equal(
			getCharset('text/html; charset="ISO-8859-1"', bytes(""), true),
			"ISO-8859-1",
		);
		assert.equal(
			getCharset(
				"text/html",
				bytes(
					'<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">',
				),
				true,
			),
			"shift_jis",
		);
		assert.equal(
			getCharset("text/plain", bytes('<meta charset="latin1">'), false),
			"utf-8",
		);
		assert.equal(getCharset("text/html", bytes("<p>none</p>"), true), "utf-8");
	});
});

describe("toBase64", () => {
	it("encodes only the viewed range of a subarray", () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 3);
		assert.equal(toBase64(bytes), Buffer.from([2, 3]).toString("base64"));
	});
});

describe("decodeWindows1252", () => {
	// Every byte, so the whole 0x80 to 0x9F remapping is checked, not a sample.
	const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);

	it("maps the high control range to the WHATWG windows-1252 characters", () => {
		const decoded = decodeWindows1252(allBytes);
		assert.equal(decoded.length, 256);
		assert.equal(
			decoded.slice(0, 0x80),
			Buffer.from(allBytes.subarray(0, 0x80)).toString("latin1"),
		);
		assert.equal(decoded[0x80], "€");
		assert.equal(decoded[0x93], "“");
		assert.equal(decoded[0x96], String.fromCharCode(0x2013));
		assert.equal(decoded[0x9f], "Ÿ");
		// Undefined bytes keep their own code point, matching browsers.
		assert.equal(decoded[0x81], "\u0081");
		assert.equal(decoded[0xe9], "é");
	});

	it("matches the native decoder wherever the native decoder is correct", (t) => {
		const native = new TextDecoder("windows-1252").decode(allBytes);
		if (native[0x80] !== "€") {
			t.skip("this Node release decodes windows-1252 as Latin-1");
			return;
		}
		assert.equal(decodeWindows1252(allBytes), native);
	});

	it("respects the view offset of a subarray", () => {
		assert.equal(decodeWindows1252(allBytes.subarray(0x80, 0x82)), "€\u0081");
	});
});
