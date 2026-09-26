import assert from "node:assert/strict";
import { describe, it } from "node:test";
import domino from "@mixmark-io/domino";
import { minifyText } from "../src/minify.ts";

// Seeded so a failure reproduces exactly; bump ITERATIONS locally to search
// harder, and put a failing seed in the message to replay it.
const ITERATIONS = 300;

const mulberry32 = (seed: number) => {
	let state = seed;
	return () => {
		state += 0x6d2b79f5;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T =>
	items[Math.floor(random() * items.length)] as T;

const WHITESPACE = ["", " ", "\n", "\t", "\r\n", "  \n  "] as const;
// Lexemes whose spelling a parse-and-reserialize minifier would change.
const NUMBERS = ["0", "-0", "1.0", "1e5", "-12.50E-3", "12345678901234567890"];
const STRINGS = [
	'""',
	'"plain"',
	'"with  spaces\\tand tab"',
	'"quote \\" inside"',
	'"back\\\\slash"',
	'"café 🙂"',
	'"\\u00e9 escaped"',
	'"{ not: [structure] }"',
];

interface Generated {
	pretty: string;
	compact: string;
}

const generateJson = (random: Random, depth: number): Generated => {
	const ws = () => pick(random, WHITESPACE);
	const roll = random();
	if (depth <= 0 || roll < 0.4) {
		const token = pick(random, [
			...NUMBERS,
			...STRINGS,
			"true",
			"false",
			"null",
		]);
		return { pretty: token, compact: token };
	}
	const count = Math.floor(random() * 4);
	const children = Array.from({ length: count }, () =>
		generateJson(random, depth - 1),
	);
	if (roll < 0.7) {
		return {
			pretty: `[${ws()}${children.map((child) => child.pretty).join(`${ws()},${ws()}`)}${ws()}]`,
			compact: `[${children.map((child) => child.compact).join(",")}]`,
		};
	}
	const keys = children.map(() => pick(random, STRINGS));
	return {
		pretty: `{${ws()}${children.map((child, index) => `${keys[index]}${ws()}:${ws()}${child.pretty}`).join(`${ws()},${ws()}`)}${ws()}}`,
		compact: `{${children.map((child, index) => `${keys[index]}:${child.compact}`).join(",")}}`,
	};
};

const WORDS = ["alpha", "beta", "gamma", "&amp;", "caf\u00e9", "x"];

// Children follow valid content models. Invalid nesting triggers parser error
// recovery whose result depends on whitespace, which would make the property
// fail for reasons unrelated to the minifier.
const CHILDREN: Record<string, readonly string[]> = {
	flow: ["div", "section", "p", "ul", "pre", "span", "b", "em", "#text"],
	phrasing: ["span", "b", "em", "#text"],
	list: ["li"],
};
const CONTENT_MODEL: Record<string, keyof typeof CHILDREN> = {
	div: "flow",
	section: "flow",
	li: "flow",
	p: "phrasing",
	pre: "phrasing",
	span: "phrasing",
	b: "phrasing",
	em: "phrasing",
	ul: "list",
};

const generateHtml = (random: Random, depth: number, tag = "div"): string => {
	const ws = () => pick(random, WHITESPACE);
	const model = CONTENT_MODEL[tag] ?? "flow";
	const count = 1 + Math.floor(random() * 3);
	const children = Array.from({ length: count }, () => {
		const options = CHILDREN[model] ?? [];
		const child =
			depth <= 0 && model !== "list" ? "#text" : pick(random, options);
		if (child === "#text")
			return `${ws()}${pick(random, WORDS)}${ws()}${pick(random, WORDS)}${ws()}`;
		return generateHtml(random, depth - 1, child);
	}).join(model === "list" ? ws() : "");
	return `<${tag} class="c${Math.floor(random() * 9)}">${children}</${tag}>`;
};

const inspect = (html: string) => {
	const document = domino.createDocument(`<body>${html}</body>`, true);
	const tags: string[] = [];
	const all = document.body.querySelectorAll("*");
	for (let index = 0; index < all.length; index++)
		tags.push(all.item(index).tagName);
	const pres: string[] = [];
	const preNodes = document.body.querySelectorAll("pre");
	for (let index = 0; index < preNodes.length; index++)
		pres.push(preNodes.item(index).textContent ?? "");
	return {
		tags,
		pres,
		text: (document.body.textContent ?? "").replace(/\s+/g, ""),
	};
};

describe("minifier properties", () => {
	it("JSON minification removes exactly the insignificant whitespace", () => {
		for (let seed = 1; seed <= ITERATIONS; seed++) {
			const { pretty, compact } = generateJson(mulberry32(seed), 4);
			const result = minifyText(pretty, "application/json");
			assert.equal(result.content, compact, `seed ${seed}: ${pretty}`);
			assert.deepEqual(JSON.parse(result.content), JSON.parse(pretty));
		}
	});

	it("HTML minification keeps structure, preformatted text, and every visible character", () => {
		for (let seed = 1; seed <= ITERATIONS; seed++) {
			const html = generateHtml(mulberry32(seed), 4);
			const result = minifyText(html, "text/html");
			const before = inspect(html);
			const after = inspect(result.content);
			assert.deepEqual(after.tags, before.tags, `seed ${seed}: tags`);
			assert.deepEqual(after.pres, before.pres, `seed ${seed}: pre`);
			assert.equal(after.text, before.text, `seed ${seed}: text`);
		}
	});
});
