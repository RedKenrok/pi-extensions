import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertHtmlToMarkdown, extractTitle } from "../src/html.ts";

const page = (body: string, head = "") =>
	`<html><head>${head}</head><body>${body}</body></html>`;

describe("convertHtmlToMarkdown", () => {
	it("resolves relative links against <base href>", () => {
		const { content } = convertHtmlToMarkdown(
			page('<main><a href="guide">Guide</a></main>', '<base href="/docs/v2/">'),
			"https://example.com/index.html",
		);
		assert.match(content, /\(https:\/\/example\.com\/docs\/v2\/guide\)/);
	});

	it("strips links and images with unsafe protocols but keeps their text", () => {
		const { content } = convertHtmlToMarkdown(
			page(
				'<main><a href="javascript:alert(1)">Run</a> <a href="mailto:a@b.test">Mail</a><img src="data:image/png;base64,AA" alt="pic"></main>',
			),
			"https://example.com/",
		);
		assert.doesNotMatch(content, /javascript:|data:/);
		assert.match(content, /Run/);
		assert.match(content, /mailto:a@b\.test/);
	});

	it("uses lazy-loading image sources when src is missing", () => {
		const { content } = convertHtmlToMarkdown(
			page(
				'<main><img data-src="/a.png" alt="A"><img srcset="/b.png 1x, /b2.png 2x" alt="B"></main>',
			),
			"https://example.com/p/",
		);
		assert.match(content, /!\[A\]\(https:\/\/example\.com\/a\.png\)/);
		assert.match(content, /!\[B\]\(https:\/\/example\.com\/b\.png\)/);
	});

	it("keeps article headers while removing page chrome", () => {
		const { content } = convertHtmlToMarkdown(
			page(
				"<header>Site banner</header><article><header><h1>Real title</h1><p>By Someone</p></header><p>Body text here.</p><footer>Footnote</footer></article><footer>Copyright</footer>",
			),
			"https://example.com/",
		);
		assert.match(content, /Real title/);
		assert.match(content, /By Someone/);
		assert.match(content, /Footnote/);
		assert.doesNotMatch(content, /Site banner|Copyright/);
	});

	it("prefers substantial main content over a small article teaser", () => {
		const prose = "Long paragraph of real content. ".repeat(40);
		const { content } = convertHtmlToMarkdown(
			page(`<main><article>Teaser card</article><p>${prose}</p></main>`),
			"https://example.com/",
		);
		assert.match(content, /Long paragraph/);
	});

	it("still prefers an article that holds most of the text", () => {
		const prose = "Article prose. ".repeat(40);
		const { content } = convertHtmlToMarkdown(
			page(
				`<main><p>Related links</p><article><p>${prose}</p></article></main>`,
			),
			"https://example.com/",
		);
		assert.doesNotMatch(content, /Related links/);
	});

	it("emits ATX headings, fenced code, and dash bullets", () => {
		const { content } = convertHtmlToMarkdown(
			"<main><h1>Title</h1><h2>Section</h2><ul><li>one</li></ul><pre><code>const a = 1;\n</code></pre></main>",
			"https://example.com/",
		);
		assert.match(content, /^# Title$/m);
		assert.match(content, /^## Section$/m);
		assert.match(content, /^- {1,3}one$/m);
		assert.match(content, /^```\nconst a = 1;\n```$/m);
		assert.doesNotMatch(content, /^={3,}$|^-{3,}$/m);
	});

	it("falls back to the body when no container has content", () => {
		const { content, title } = convertHtmlToMarkdown(
			page("<p>Just a body</p>"),
			"https://example.com/",
		);
		assert.equal(content, "Just a body");
		assert.equal(title, undefined);
	});
});

describe("extractTitle", () => {
	it("decodes entities without parsing the whole document", () => {
		assert.equal(
			extractTitle(page("", "<title> R&eacute;sum&eacute; &amp; CV </title>")),
			"Résumé & CV",
		);
		assert.equal(
			extractTitle(page("", "<TITLE lang=en>Upper</TITLE>")),
			"Upper",
		);
		assert.equal(extractTitle(page("<p>no title</p>")), undefined);
		assert.equal(extractTitle("<title></title>"), undefined);
		assert.equal(extractTitle("<title>a <b> c</title>"), "a <b> c");
	});
});
