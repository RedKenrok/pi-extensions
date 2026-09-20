import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { minifyText } from "../src/minify.ts";

describe("minifyText", () => {
	it("minifies JSON from its content type", () => {
		assert.deepEqual(
			minifyText('{ "items": [1, 2] }', "application/json; charset=utf-8"),
			{ content: '{"items":[1,2]}', minified: true },
		);
	});

	it("detects JSON when the content type is missing", () => {
		assert.equal(minifyText("[ 1, 2 ]", "").content, "[1,2]");
		assert.equal(
			minifyText('{ "message": "bad" }', "application/problem+json").content,
			'{"message":"bad"}',
		);
	});

	it("minifies XML without changing quoted attributes or CDATA", () => {
		const xml = `
<?xml version="1.0"?>
<root>
  <child comparison="> <">value</child>
  <![CDATA[a < b]]>
</root>
`;

		assert.equal(
			minifyText(xml, "application/atom+xml").content,
			'<?xml version="1.0"?><root><child comparison="> <">value</child><![CDATA[a < b]]></root>',
		);
	});

	it("minifies NDJSON one record at a time", () => {
		const ndjson = `
{ "id": 1, "tags": ["a", "b"] }

{ "id": 2, "active": true }
`;

		assert.deepEqual(minifyText(ndjson, "application/x-ndjson"), {
			content: '{"id":1,"tags":["a","b"]}\n{"id":2,"active":true}',
			minified: true,
		});
	});

	it("does not partially minify malformed NDJSON", () => {
		const ndjson = '{ "valid": true }\n{ broken }';
		assert.deepEqual(minifyText(ndjson, "application/jsonl"), {
			content: ndjson,
			minified: false,
		});
	});

	it("supports NDJSON content-type and line-ending variants", () => {
		const contentTypes = [
			"application/ndjson",
			"application/x-ndjson; charset=utf-8",
			"text/x-ndjson",
			"application/jsonl",
			"application/jsonlines",
		];
		const input = '1\r\n[ 2, 3 ]\r\n\r\n{ "four": true }\r\n';
		const expected = '1\n[2,3]\n{"four":true}';

		for (const contentType of contentTypes) {
			assert.equal(
				minifyText(input, contentType).content,
				expected,
				contentType,
			);
		}
	});

	it("reports already compact NDJSON as unchanged", () => {
		const ndjson = '{"id":1}\n{"id":2}';
		assert.deepEqual(minifyText(ndjson, "application/x-ndjson"), {
			content: ndjson,
			minified: false,
		});
	});

	it("does not interpret multiple JSON documents as NDJSON without its content type", () => {
		const input = '{ "id": 1 }\n{ "id": 2 }';
		assert.deepEqual(minifyText(input, "application/json"), {
			content: input,
			minified: false,
		});
	});

	it("minifies ordinary HTML whitespace while preserving raw text", () => {
		const html = `
<!doctype html>
<html>
  <body>
    <!-- remove me -->
    <div>
      compact   this
    </div>
    <p>  preserve
      this  </p>
    <div>Hello <span>world</span> again</div>
    <div><span>one</span> <span>two</span></div>
		<script>  if (a < b) value = "keep   this";  </script>
		<div>
		  compact after script
		</div>
  </body>
</html>
`;
		const result = minifyText(html, "text/html; charset=utf-8");

		assert.equal(result.minified, true);
		assert.doesNotMatch(result.content, /remove me/);
		assert.match(result.content, /<div> compact this <\/div>/);
		assert.match(result.content, /<p> preserve this <\/p>/);
		assert.match(result.content, /Hello <span>world<\/span> again/);
		assert.match(result.content, /<span>one<\/span> <span>two<\/span>/);
		assert.match(
			result.content,
			/<script> {2}if \(a < b\) value = "keep {3}this"; {2}<\/script>/,
		);
		assert.match(result.content, /<div> compact after script <\/div>/);
	});

	it("preserves whitespace in whitespace-preserving HTML elements", () => {
		const sensitiveElements = ["pre", "script", "style", "textarea"];

		for (const element of sensitiveElements) {
			const sensitiveContent = "  first\n    second   ";
			const result = minifyText(
				`<main>\n<${element}>${sensitiveContent}</${element}>\n</main>`,
				"text/html",
			);
			assert.match(
				result.content,
				new RegExp(`<${element}>${sensitiveContent}</${element}>`),
				element,
			);
		}
	});

	it("preserves spaces between sensitive siblings", () => {
		assert.equal(
			minifyText(
				"<div><span>one</span>\n\t<strong>two</strong></div>",
				"text/html",
			).content,
			"<div><span>one</span> <strong>two</strong></div>",
		);
	});

	it("does not confuse attribute delimiters or void elements with tags", () => {
		const html = `
<main>
  <img alt="comparison: a > b" data-template='<span>'>
  <div data-comparison="a > b">
    compact   this
  </div>
</main>
`;

		assert.equal(
			minifyText(html, "text/html").content,
			'<main><img alt="comparison: a > b" data-template=\'<span>\'><div data-comparison="a > b"> compact this </div></main>',
		);
	});

	it("removes ordinary HTML comments and preserves conditional comments", () => {
		const html = `
<main>
  <!-- remove outside -->
  <p>one<!-- remove inside -->two</p>
  <!--[if IE]><div>legacy</div><![endif]-->
</main>
`;
		const result = minifyText(html, "text/html").content;

		assert.doesNotMatch(result, /remove outside|remove inside/);
		assert.match(result, /<p>onetwo<\/p>/);
		assert.match(result, /<!--\[if IE\]><div>legacy<\/div><!\[endif\]-->/);
	});

	it("preserves raw text containing less-than signs", () => {
		const html = `
<main>
  <style>  .item::before { content: "<  value"; }  </style>
  <textarea>  one < two\n three  </textarea>
  <script>  if (one < two) console.log("  keep  ");  </script>
  <section>  compact   afterward  </section>
</main>
`;
		const result = minifyText(html, "text/html").content;

		assert.match(
			result,
			/<style> {2}\.item::before \{ content: "< {2}value"; \} {2}<\/style>/,
		);
		assert.match(result, /<textarea> {2}one < two\n three {2}<\/textarea>/);
		assert.match(
			result,
			/<script> {2}if \(one < two\) console\.log\(" {2}keep {2}"\); {2}<\/script>/,
		);
		assert.match(result, /<section> compact afterward <\/section>/);
	});

	it("handles case-insensitive HTML tag names", () => {
		assert.equal(
			minifyText(
				"<MAIN>\n  <SPAN>  preserve\n me  </SPAN>\n</MAIN>",
				"TEXT/HTML; CHARSET=UTF-8",
			).content,
			"<MAIN><SPAN> preserve me </SPAN></MAIN>",
		);
	});

	it("preserves XML mixed content and complex doctypes", () => {
		const xml = `
<!DOCTYPE note [
  <!ELEMENT note (#PCDATA)>
]>
<note>
  <empty />
  <message>Hello <b>world</b> again</message>
</note>
`;

		assert.equal(
			minifyText(xml, "text/xml").content,
			"<!DOCTYPE note [\n  <!ELEMENT note (#PCDATA)>\n]><note><empty /><message>Hello <b>world</b> again</message></note>",
		);
	});

	it("leaves unterminated XML and HTML markup unchanged", () => {
		for (const [content, contentType] of [
			["<root><child", "application/xml"],
			["<main><div", "text/html"],
		] as const) {
			assert.deepEqual(minifyText(content, contentType), {
				content,
				minified: false,
			});
		}
	});

	it("handles JSON primitives and already compact JSON", () => {
		assert.deepEqual(minifyText('  "value"  ', "application/json"), {
			content: '"value"',
			minified: true,
		});
		assert.deepEqual(minifyText("null", "application/json"), {
			content: "null",
			minified: false,
		});
	});

	it("leaves malformed or unsupported content unchanged", () => {
		assert.deepEqual(minifyText("{broken", "application/json"), {
			content: "{broken",
			minified: false,
		});
		assert.deepEqual(minifyText("plain text", "text/plain"), {
			content: "plain text",
			minified: false,
		});
	});
});
