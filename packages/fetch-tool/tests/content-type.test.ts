import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyContentType,
	looksLikeText,
	mediaType,
} from "../src/content-type.ts";

describe("classifyContentType", () => {
	it("classifies media types consistently", () => {
		const cases: Array<[string, string]> = [
			["", "unknown"],
			["text/html; charset=utf-8", "html"],
			["TEXT/HTML", "html"],
			["application/json", "json"],
			["text/json", "json"],
			["application/problem+json; charset=utf-8", "json"],
			["application/x-ndjson", "ndjson"],
			["text/jsonl", "ndjson"],
			["application/jsonlines", "ndjson"],
			["application/xml", "xml"],
			["image/svg+xml", "xml"],
			["application/xhtml+xml", "xml"],
			["text/plain", "text"],
			["text/css", "text"],
			["application/javascript", "text"],
			["application/x-javascript", "text"],
			["application/ecmascript", "text"],
			["application/yaml", "text"],
			["application/toml", "text"],
			["application/graphql", "text"],
			["application/x-www-form-urlencoded", "text"],
			["application/sql", "text"],
			["application/jsonp", "binary"],
			["application/octet-stream", "binary"],
			["image/png", "binary"],
		];
		for (const [contentType, expected] of cases) {
			assert.equal(classifyContentType(contentType), expected, contentType);
		}
	});

	it("extracts the bare media type", () => {
		assert.equal(mediaType(" Text/Plain ; charset=utf-8"), "text/plain");
		assert.equal(mediaType(""), "");
	});
});

describe("looksLikeText", () => {
	it("accepts UTF-8 text, including a character cut by the sniff window", () => {
		assert.equal(
			looksLikeText(new TextEncoder().encode("hello\n\tworld")),
			true,
		);
		const cut = new TextEncoder().encode(`${"a".repeat(4095)}é`);
		assert.equal(looksLikeText(cut), true);
		assert.equal(looksLikeText(new Uint8Array()), true);
	});

	it("rejects NUL bytes, control bytes, and invalid UTF-8", () => {
		assert.equal(looksLikeText(new Uint8Array([0x61, 0x00])), false);
		assert.equal(looksLikeText(new Uint8Array([0x61, 0x01])), false);
		assert.equal(looksLikeText(new Uint8Array([0xff, 0xfe, 0x61])), false);
	});
});
