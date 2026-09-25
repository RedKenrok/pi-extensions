import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import fetchTool from "../src/fetch.ts";

interface FetchDetails {
	body?: string;
	headers?: Record<string, string>;
	minified?: boolean;
	outputSize?: number;
	previewSize?: number;
	returnedOutputSize?: number;
	title?: string;
	truncated?: boolean;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const getDetails = (
	result: Awaited<ReturnType<ReturnType<typeof fetchTool>["execute"]>>,
): FetchDetails => {
	return result.details as FetchDetails;
};

const getText = (
	result: Awaited<ReturnType<ReturnType<typeof fetchTool>["execute"]>>,
): string => {
	const content = result.content[0];
	assert.equal(content?.type, "text");
	return content.text;
};

describe("fetch tool", () => {
	it("applies runtime defaults and returns only safe headers", async () => {
		let requestSignal: AbortSignal | null | undefined;
		globalThis.fetch = async (_input, init) => {
			requestSignal = init?.signal;
			return new Response('{ "value": 1 }', {
				headers: {
					"cache-control": "max-age=60",
					"content-type": "application/json",
					"x-private-header": "hidden",
				},
			});
		};

		const result = await fetchTool().execute(
			"call",
			{ url: "https://example.com/data" },
			undefined,
		);
		const details = getDetails(result);

		assert.ok(requestSignal instanceof AbortSignal);
		assert.equal(details.body, '{"value":1}');
		assert.equal(details.minified, true);
		assert.equal(details.headers?.["cache-control"], "max-age=60");
		assert.equal(details.headers?.["x-private-header"], undefined);
	});

	it("truncates text output without rejecting the response", async () => {
		globalThis.fetch = async () =>
			new Response("x".repeat(2_000), {
				headers: { "content-type": "text/plain" },
			});

		const result = await fetchTool().execute(
			"call",
			{ url: "https://example.com/large", maxOutputSize: 1_024 },
			undefined,
		);
		const details = getDetails(result);

		assert.equal(details.body?.length, 1_024);
		assert.equal(details.outputSize, 2_000);
		assert.equal(details.returnedOutputSize, 1_024);
		assert.equal(details.truncated, true);
		assert.match(getText(result), /Response truncated/);
	});

	it("does not emit a replacement character when truncating UTF-8 text", async () => {
		globalThis.fetch = async () =>
			new Response(`a${"🙂".repeat(600)}`, {
				headers: { "content-type": "text/plain" },
			});
		const result = await fetchTool().execute(
			"call",
			{ url: "https://example.com/unicode", maxOutputSize: 1_024 },
			undefined,
		);
		const details = getDetails(result);
		assert.equal(details.truncated, true);
		assert.doesNotMatch(details.body ?? "", /\uFFFD/);
	});

	it("preserves a literal replacement character at the truncation boundary", async () => {
		const prefix = `${"a".repeat(1_021)}\uFFFD`;
		globalThis.fetch = async () =>
			new Response(`${prefix}🙂`, {
				headers: { "content-type": "text/plain" },
			});
		const result = await fetchTool().execute(
			"call",
			{
				url: "https://example.com/unicode",
				maxOutputSize: 1_024,
			},
			undefined,
		);
		assert.equal(getDetails(result).body, prefix);
		assert.equal(getDetails(result).returnedOutputSize, 1_024);
	});

	it("distinguishes binary download size from preview size", async () => {
		globalThis.fetch = async () =>
			new Response(new Uint8Array(400).fill(65), {
				headers: { "content-type": "application/octet-stream" },
			});
		const result = await fetchTool().execute(
			"call",
			{ url: "https://example.com/file" },
			undefined,
		);
		assert.match(
			getText(result),
			/downloaded 400 bytes; showing a 150-byte preview/,
		);
		assert.equal(getDetails(result).previewSize, 150);
	});

	it("only base64-encodes a short binary preview", async () => {
		globalThis.fetch = async () =>
			new Response(new Uint8Array(4_000).fill(65), {
				headers: { "content-type": "application/octet-stream" },
			});

		const result = await fetchTool().execute(
			"call",
			{ url: "https://example.com/file" },
			undefined,
		);

		assert.equal(getDetails(result).body, undefined);
		assert.equal(getDetails(result).truncated, true);
		assert.ok(getText(result).length < 1_000);
	});

	it("decodes declared charsets and extracts useful markdown metadata", async () => {
		const html =
			'<html><head><title>R\u00e9sum\u00e9</title></head><body><nav>Menu</nav><article><h1>Caf\u00e9 \u20ac</h1><span hidden>Secret</span><a href="/docs">Docs</a></article></body></html>';
		const bytes = Uint8Array.from(html, (character) => {
			if (character === "\u00e9") return 0xe9;
			if (character === "\u20ac") return 0x80;
			return character.charCodeAt(0);
		});
		globalThis.fetch = async () =>
			new Response(bytes, {
				headers: { "content-type": "text/html; charset=windows-1252" },
			});

		const result = await fetchTool().execute(
			"call",
			{ url: "https://example.com/page", markdown: true },
			undefined,
		);
		const details = getDetails(result);

		assert.equal(details.title, "R\u00e9sum\u00e9");
		assert.match(details.body ?? "", /Caf\u00e9 \u20ac/);
		assert.match(details.body ?? "", /https:\/\/example\.com\/docs/);
		assert.doesNotMatch(details.body ?? "", /Menu/);
		assert.doesNotMatch(details.body ?? "", /Secret/);
	});

	it("honors markdown false for HTML larger than the ordinary download limit", async () => {
		const html = `<html><body><main>raw-marker${"x".repeat(16 * 1024 * 1024)}</main></body></html>`;
		globalThis.fetch = async () =>
			new Response(html, { headers: { "content-type": "text/html" } });

		const result = await fetchTool().execute(
			"call",
			{
				url: "https://example.com/large",
				markdown: false,
				minify: false,
				maxOutputSize: 1024,
			},
			undefined,
		);
		const details = getDetails(result) as ReturnType<typeof getDetails> & {
			bodyType?: string;
		};

		assert.equal(details.bodyType, "text");
		assert.match(details.body ?? "", /^<html><body><main>raw-marker/);
		assert.equal(details.truncated, true);
	});

	it("rejects fractional limits as validation errors", async () => {
		for (const params of [
			{ url: "https://example.com", timeout: 100.5 },
			{ url: "https://example.com", maxOutputSize: 1024.5 },
		]) {
			await assert.rejects(
				fetchTool().execute("call", params, undefined),
				(error: Error & { errorType?: string }) =>
					error.errorType === "validation",
			);
		}
	});

	it("throws validation errors for invalid timeout and GET/HEAD bodies", async () => {
		for (const params of [
			{ url: "https://example.com", timeout: Infinity },
			{ url: "https://example.com", timeout: NaN },
			{ url: "https://example.com", timeout: -Infinity },
			{ url: "https://example.com", method: "GET" as const, body: "x" },
			{ url: "https://example.com", method: "HEAD" as const, body: "x" },
		]) {
			await assert.rejects(fetchTool().execute("call", params, undefined));
		}
	});

	it("cancels a body when its declared length is oversized", async () => {
		let cancelled = false;
		globalThis.fetch = async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
				{
					headers: { "content-length": String(17 * 1024 * 1024) },
				},
			);
		await assert.rejects(
			fetchTool().execute("call", { url: "https://example.com" }, undefined),
		);
		assert.equal(cancelled, true);
	});

	it("throws on an over-limit declared length and cancels oversized streams", async () => {
		globalThis.fetch = async () =>
			new Response("x", {
				headers: { "content-length": String(17 * 1024 * 1024) },
			});
		await assert.rejects(
			fetchTool().execute("call", { url: "https://example.com" }, undefined),
			/exceeds maximum/,
		);

		let cancelled = false;
		globalThis.fetch = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(17 * 1024 * 1024));
					},
					cancel() {
						cancelled = true;
					},
				}),
				{ headers: { "content-type": "application/octet-stream" } },
			);
		await assert.rejects(
			fetchTool().execute("call", { url: "https://example.com" }, undefined),
		);
		assert.equal(cancelled, true);
	});

	it("cancels a response body that arrives after caller abort", async () => {
		let cancelled = false;
		globalThis.fetch = async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return {
				status: 200,
				statusText: "OK",
				headers: new Headers(),
				url: "https://example.com/late",
				body: {
					cancel() {
						cancelled = true;
						return new Promise<void>(() => undefined);
					},
				},
			} as unknown as Response;
		};
		const controller = new AbortController();
		const request = fetchTool().execute(
			"call",
			{ url: "https://example.com/late" },
			controller.signal,
		);
		controller.abort(new Error("stop"));

		await assert.rejects(request);
		assert.equal(cancelled, true);
	});

	it("does not await a stalled cancellation for an oversized response", async () => {
		let cancelled = false;
		globalThis.fetch = async () =>
			({
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-length": String(17 * 1024 * 1024) }),
				url: "https://example.com/large",
				body: {
					cancel() {
						cancelled = true;
						return new Promise<void>(() => undefined);
					},
				},
			}) as unknown as Response;

		await assert.rejects(
			Promise.race([
				fetchTool().execute(
					"call",
					{ url: "https://example.com/large" },
					undefined,
				),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("cleanup stalled")), 100),
				),
			]),
			/exceeds maximum/,
		);
		assert.equal(cancelled, true);
	});

	it("reports caller cancellation separately from timeout", async () => {
		globalThis.fetch = async (_input, init) => {
			if (init?.signal?.aborted) {
				throw init.signal.reason;
			}
			throw new Error("Expected an aborted signal");
		};
		const controller = new AbortController();
		controller.abort(new Error("stop"));

		await assert.rejects(
			fetchTool().execute(
				"call",
				{ url: "https://example.com" },
				controller.signal,
			),
			(error: Error & { errorType?: string }) => error.errorType === "aborted",
		);
	});
});
