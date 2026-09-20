import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import searchTool from "../src/search.ts";

interface SearchDetails {
	results: Array<{ title: string; url: string; description: string }>;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("search tool", () => {
	it("uses a lowercase name, validates URLs, and returns at most ten results", async () => {
		let requestSignal: AbortSignal | null | undefined;
		const rows = Array.from({ length: 12 }, (_, index) => {
			const url =
				index === 0
					? `https://duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.com/wrapped")}`
					: `https://example.com/result-${index}?source=duckduckgo.com`;
			return `<tr><td><a class="result-link" href="${url}">Result ${index}</a></td></tr><tr><td class="result-snippet">Description ${index}</td></tr>`;
		}).join("");
		const html = `<html><body><a class="result-link" href="javascript:alert(1)">Bad</a><table>${rows}</table></body></html>`;
		globalThis.fetch = async (_input, init) => {
			requestSignal = init?.signal;
			return new Response(html, {
				headers: { "content-type": "text/html" },
			});
		};

		const tool = searchTool();
		const result = await tool.execute("call", { queries: "test" }, undefined);
		const details = result.details as SearchDetails;

		assert.equal(tool.name, "search");
		assert.ok(requestSignal instanceof AbortSignal);
		assert.equal(details.results.length, 10);
		assert.equal(details.results[0]?.url, "https://example.com/wrapped");
		assert.equal(
			details.results[1]?.url,
			"https://example.com/result-1?source=duckduckgo.com",
		);
	});

	it("rejects empty, overlong, and excessive queries before fetching", async () => {
		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls++;
			return new Response("");
		};

		const empty = await searchTool().execute(
			"call",
			{ queries: "  " },
			undefined,
		);
		const excessive = await searchTool().execute(
			"call",
			{ queries: Array.from({ length: 9 }, (_, index) => `query ${index}`) },
			undefined,
		);
		const overlong = await searchTool().execute(
			"call",
			{ queries: "x".repeat(501) },
			undefined,
		);

		for (const result of [empty, excessive, overlong]) {
			assert.equal(
				(result.details as { errorType: string }).errorType,
				"validation",
			);
		}
		assert.equal(fetchCalls, 0);
	});

	it("limits concurrency and truncates oversized result fields", async () => {
		let active = 0;
		let peak = 0;
		globalThis.fetch = async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return new Response(
				`<table><tr><td><a class="result-link" href="https://example.com">${"t".repeat(400)}</a></td></tr><tr><td class="result-snippet">${"d".repeat(1_200)}</td></tr></table>`,
			);
		};

		const result = await searchTool().execute(
			"call",
			{ queries: Array.from({ length: 8 }, (_, index) => `query ${index}`) },
			undefined,
		);
		const outcomes = (result.details as { results: SearchDetails[] }).results;

		assert.equal(peak, 4);
		assert.equal(outcomes[0]?.results[0]?.title.length, 300);
		assert.equal(outcomes[0]?.results[0]?.description.length, 1_000);
	});
});
