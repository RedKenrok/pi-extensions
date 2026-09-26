import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { deferred, nextTurn } from "../../../test-support/async.ts";
import fetchTool, { type FetchParams } from "../src/fetch.ts";

type Result = Awaited<ReturnType<ReturnType<typeof fetchTool>["execute"]>>;
type ToolError = Error & { errorType?: string; url?: string };

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restoreAll();
	delete process.env.PI_EXT_DEBUG;
});

const execute = (params: FetchParams, signal?: AbortSignal) =>
	fetchTool().execute("call", params, signal);

const getText = (result: Result): string => {
	const content = result.content[0];
	assert.equal(content?.type, "text");
	return content.text;
};

// The body is only in the model-facing text, after the "Response...:" line
// and before an optional truncation notice.
const getBody = (result: Result): string => {
	const text = getText(result);
	const start = text.indexOf("\nResponse");
	assert.notEqual(start, -1);
	const afterHeader = text.slice(start + 1);
	return afterHeader
		.slice(afterHeader.indexOf("\n") + 1)
		.replace(/\n\n\[Response truncated[^\]]*\]$/, "");
};

const respondWith = (
	body: BodyInit | null,
	responseInit: ResponseInit = {},
) => {
	const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
	globalThis.fetch = async (input, init) => {
		requests.push({ url: String(input), init });
		// Each call needs a fresh Response because a body can be read only once.
		return new Response(
			body instanceof Uint8Array ? body.slice() : body,
			responseInit,
		);
	};
	return requests;
};

// A body whose cancel never settles, to prove cleanup is fire-and-forget.
const stalledCancelBody = (onCancel: () => void) =>
	new ReadableStream<Uint8Array>({
		cancel() {
			onCancel();
			return new Promise<void>(() => undefined);
		},
	});

const settlesWithinTurns = async (
	promise: Promise<unknown>,
	turns = 5,
): Promise<unknown> => {
	const guarded = promise.then(
		() => "resolved",
		(error: unknown) => error,
	);
	const stalled = (async () => {
		for (let turn = 0; turn < turns; turn++) await nextTurn();
		return "stalled";
	})();
	return Promise.race([guarded, stalled]);
};

describe("fetch tool", () => {
	it("applies runtime defaults and returns only safe headers", async () => {
		const requests = respondWith('{ "value": 1 }', {
			headers: {
				"cache-control": "max-age=60",
				"content-type": "application/json",
				"x-private-header": "hidden",
			},
		});

		const result = await execute({ url: "https://example.com/data" });
		const { details } = result;

		assert.ok(requests[0]?.init?.signal instanceof AbortSignal);
		assert.equal(getBody(result), '{"value":1}');
		assert.equal(details.minified, true);
		assert.equal(details.headers?.["cache-control"], "max-age=60");
		assert.equal(details.headers?.["x-private-header"], undefined);
		assert.equal("body" in details, false);
	});

	it("truncates text output without rejecting the response", async () => {
		respondWith("x".repeat(2_000), {
			headers: { "content-type": "text/plain" },
		});

		const result = await execute({
			url: "https://example.com/large",
			maxOutputSize: 1_024,
		});

		assert.equal(getBody(result).length, 1_024);
		assert.equal(result.details.outputSize, 2_000);
		assert.equal(result.details.returnedOutputSize, 1_024);
		assert.equal(result.details.truncated, true);
		assert.match(getText(result), /Response truncated/);
	});

	it("does not emit a replacement character when truncating UTF-8 text", async () => {
		respondWith(`a${"🙂".repeat(600)}`, {
			headers: { "content-type": "text/plain" },
		});
		const result = await execute({
			url: "https://example.com/unicode",
			maxOutputSize: 1_024,
		});
		assert.equal(result.details.truncated, true);
		assert.doesNotMatch(getBody(result), /�/);
		assert.equal(result.details.returnedOutputSize, 1_021);
	});

	it("preserves a literal replacement character at the truncation boundary", async () => {
		const prefix = `${"a".repeat(1_021)}�`;
		respondWith(`${prefix}🙂`, {
			headers: { "content-type": "text/plain" },
		});
		const result = await execute({
			url: "https://example.com/unicode",
			maxOutputSize: 1_024,
		});
		assert.equal(getBody(result), prefix);
		assert.equal(result.details.returnedOutputSize, 1_024);
	});

	it("distinguishes binary download size from preview size", async () => {
		respondWith(new Uint8Array(400).fill(65), {
			headers: { "content-type": "application/octet-stream" },
		});
		const result = await execute({ url: "https://example.com/file" });
		assert.match(
			getText(result),
			/downloaded 400 bytes; showing a 150-byte preview/,
		);
		assert.equal(result.details.previewSize, 150);
		assert.equal(result.details.outputSize, undefined);
	});

	it("only base64-encodes a short binary preview", async () => {
		respondWith(new Uint8Array(4_000).fill(65), {
			headers: { "content-type": "application/octet-stream" },
		});
		const result = await execute({ url: "https://example.com/file" });
		assert.equal(result.details.truncated, true);
		assert.equal(getBody(result), Buffer.alloc(150, 65).toString("base64"));
		assert.ok(getText(result).length < 1_000);
	});

	it("decodes declared charsets and extracts useful markdown metadata", async () => {
		const html =
			'<html><head><title>Résumé</title></head><body><nav>Menu</nav><article><h1>Café €</h1><span hidden>Secret</span><a href="/docs">Docs</a></article></body></html>';
		const bytes = Uint8Array.from(html, (character) => {
			if (character === "é") return 0xe9;
			if (character === "€") return 0x80;
			return character.charCodeAt(0);
		});
		respondWith(bytes, {
			headers: { "content-type": "text/html; charset=windows-1252" },
		});

		const result = await execute({
			url: "https://example.com/page",
			markdown: true,
		});
		const body = getBody(result);

		assert.equal(result.details.title, "Résumé");
		assert.equal(result.details.markdown, "converted");
		assert.equal(result.details.bodyType, "markdown");
		assert.match(body, /Café €/);
		assert.match(body, /https:\/\/example\.com\/docs/);
		assert.doesNotMatch(body, /Menu/);
		assert.doesNotMatch(body, /Secret/);
	});

	it("sniffs a charset from a meta tag when the header has none", async () => {
		const html =
			'<html><head><meta charset="windows-1252"><title>Café</title></head><body>naïve</body></html>';
		const bytes = Uint8Array.from(html, (character) => {
			if (character === "é") return 0xe9;
			if (character === "ï") return 0xef;
			return character.charCodeAt(0);
		});
		respondWith(bytes, { headers: { "content-type": "text/html" } });
		const result = await execute({ url: "https://example.com/page" });
		assert.equal(result.details.title, "Café");
		assert.match(getBody(result), /naïve/);
	});

	it("falls back to UTF-8 for an unknown charset and reports it when debugging", async () => {
		process.env.PI_EXT_DEBUG = "fetch-tool";
		const lines: string[] = [];
		mock.method(process.stderr, "write", (line: string) => {
			lines.push(line);
			return true;
		});
		respondWith("café", {
			headers: { "content-type": "text/plain; charset=x-made-up" },
		});
		const result = await execute({ url: "https://example.com/text" });
		assert.equal(getBody(result), "café");
		assert.deepEqual(lines, ["[fetch-tool] charset_unsupported: x-made-up\n"]);
	});

	it("honors markdown false for HTML larger than the ordinary download limit", async () => {
		const html = `<html><head><title>Big</title></head><body><main>raw-marker${"x".repeat(16 * 1024 * 1024)}</main></body></html>`;
		respondWith(html, { headers: { "content-type": "text/html" } });

		const result = await execute({
			url: "https://example.com/large",
			markdown: false,
			minify: false,
			maxOutputSize: 1024,
		});

		assert.equal(result.details.bodyType, "text");
		assert.equal(result.details.title, "Big");
		assert.equal(result.details.markdown, undefined);
		assert.match(getBody(result), /^<html><head><title>Big/);
		assert.equal(result.details.truncated, true);
	});

	it("reports a failed Markdown conversion and returns the HTML", async () => {
		respondWith(
			"<html><head><title>T</title></head><body><p>x</p></body></html>",
			{
				headers: { "content-type": "text/html" },
			},
		);
		const tool = fetchTool({
			htmlToMarkdown: () => {
				throw new Error("converter broke");
			},
		});
		const result = await tool.execute(
			"call",
			{ url: "https://example.com/page", markdown: true, minify: false },
			undefined,
		);
		assert.equal(result.details.markdown, "failed");
		assert.equal(result.details.bodyType, "text");
		assert.equal(result.details.title, "T");
		assert.match(getText(result), /Markdown conversion failed/);
		assert.match(getBody(result), /<p>x<\/p>/);
	});

	it("reports Markdown requested for a non-HTML response", async () => {
		respondWith('{"a":1}', { headers: { "content-type": "application/json" } });
		const result = await execute({
			url: "https://example.com/data",
			markdown: true,
		});
		assert.equal(result.details.markdown, "not_html");
		assert.match(getText(result), /response is not HTML/);

		respondWith(new Uint8Array([0, 1, 2]), {
			headers: { "content-type": "image/png" },
		});
		const binary = await execute({
			url: "https://example.com/image",
			markdown: true,
		});
		assert.equal(binary.details.markdown, "not_html");
		assert.equal(binary.details.bodyType, "binary");
	});

	it("treats textual application types as text and sniffs a missing content type", async () => {
		respondWith("key: value\n", {
			headers: { "content-type": "application/yaml" },
		});
		assert.equal(
			getBody(await execute({ url: "https://example.com/a.yaml" })),
			"key: value\n",
		);

		respondWith("[ 1, 2 ]");
		const sniffed = await execute({ url: "https://example.com/untyped" });
		assert.equal(sniffed.details.bodyType, "text");
		assert.equal(getBody(sniffed), "[1,2]");

		respondWith(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]));
		const binary = await execute({ url: "https://example.com/blob" });
		assert.equal(binary.details.bodyType, "binary");
	});

	it("supports every response header mode", async () => {
		const headers = {
			"content-type": "text/plain",
			"x-private-header": "hidden",
		};
		for (const includeHeaders of ["all", true] as const) {
			respondWith("ok", { headers });
			const result = await execute({
				url: "https://example.com",
				includeHeaders,
			});
			assert.equal(result.details.headers?.["x-private-header"], "hidden");
		}
		for (const includeHeaders of ["none", false] as const) {
			respondWith("ok", { headers });
			const result = await execute({
				url: "https://example.com",
				includeHeaders,
			});
			assert.equal(result.details.headers, undefined);
			assert.doesNotMatch(getText(result), /Headers:/);
		}
	});

	it("does not read bodies for HEAD, 204, and 304 responses", async () => {
		for (const [method, status] of [
			["HEAD", 200],
			["GET", 204],
			["GET", 304],
		] as const) {
			let cancelled = false;
			globalThis.fetch = async () =>
				new Response(
					status === 200
						? stalledCancelBody(() => {
								cancelled = true;
							})
						: null,
					{
						status,
						// A HEAD response may advertise any length without a body.
						headers: { "content-length": String(64 * 1024 * 1024) },
					},
				);
			const result = await execute({ url: "https://example.com", method });
			assert.equal(result.details.bodyType, "none");
			assert.equal(result.details.size, 0);
			assert.match(getText(result), /\(no response body\)/);
			if (status === 200) assert.equal(cancelled, true);
		}
	});

	it("JSON-encodes object bodies and respects a caller content type in any case", async () => {
		const requests = respondWith("ok");
		await execute({
			url: "https://example.com",
			method: "POST",
			body: { name: "example", tags: [1, 2] },
		});
		const first = requests[0]?.init;
		assert.equal(first?.body, '{"name":"example","tags":[1,2]}');
		assert.equal(
			(first?.headers as Record<string, string> | undefined)?.["Content-Type"],
			"application/json",
		);

		await execute({
			url: "https://example.com",
			method: "PUT",
			headers: { "content-type": "application/merge-patch+json" },
			body: [1],
		});
		const second = requests[1]?.init?.headers as Record<string, string>;
		assert.equal(second["content-type"], "application/merge-patch+json");
		assert.equal(second["Content-Type"], undefined);

		await execute({ url: "https://example.com", method: "POST", body: "raw" });
		assert.equal(requests[2]?.init?.body, "raw");
	});

	it("adds a user agent only when the caller did not supply one", async () => {
		const requests = respondWith("ok");
		await execute({ url: "https://example.com" });
		await execute({
			url: "https://example.com",
			headers: { "user-agent": "custom/1.0" },
		});
		const defaults = requests[0]?.init?.headers as Record<string, string>;
		const custom = requests[1]?.init?.headers as Record<string, string>;
		assert.match(defaults["User-Agent"] ?? "", /Safari/);
		assert.equal(custom["user-agent"], "custom/1.0");
		assert.equal(custom["User-Agent"], undefined);
	});

	it("rejects fractional limits as validation errors", async () => {
		for (const params of [
			{ url: "https://example.com", timeout: 100.5 },
			{ url: "https://example.com", maxOutputSize: 1024.5 },
		]) {
			await assert.rejects(
				execute(params),
				(error: ToolError) => error.errorType === "validation",
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
			await assert.rejects(
				execute(params),
				(error: ToolError) => error.errorType === "validation",
			);
		}
	});

	it("rejects non-HTTP protocols and malformed URLs before any request", async () => {
		const requests = respondWith("ok");
		for (const url of [
			"file:///etc/passwd",
			"ftp://example.com",
			"not a url",
		]) {
			await assert.rejects(
				execute({ url }),
				(error: ToolError) => error.errorType === "validation",
			);
		}
		assert.equal(requests.length, 0);
	});

	it("reports network failures with their cause and redacts URL credentials", async () => {
		globalThis.fetch = async () => {
			throw new TypeError("fetch failed", {
				cause: new Error("getaddrinfo ENOTFOUND example.invalid"),
			});
		};
		await assert.rejects(
			execute({ url: "https://user:secret@example.invalid/path" }),
			(error: ToolError) => {
				assert.equal(error.errorType, "fetch");
				assert.match(error.message, /ENOTFOUND/);
				assert.doesNotMatch(error.message, /secret/);
				assert.doesNotMatch(error.url ?? "", /secret/);
				return true;
			},
		);

		respondWith("ok");
		const result = await execute({ url: "https://user:secret@example.com/" });
		assert.doesNotMatch(getText(result), /secret/);
		assert.equal(result.details.url, "https://example.com/");
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
				{ headers: { "content-length": String(17 * 1024 * 1024) } },
			);
		await assert.rejects(
			execute({ url: "https://example.com" }),
			(error: ToolError) => error.errorType === "size_limit",
		);
		assert.equal(cancelled, true);
	});

	it("cancels oversized streams without a declared length", async () => {
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
			execute({ url: "https://example.com" }),
			/exceeds maximum/,
		);
		assert.equal(cancelled, true);
	});

	it("cancels a response body that arrives after caller abort", async () => {
		let cancelled = false;
		const arrival = deferred<void>();
		globalThis.fetch = async () => {
			await arrival.promise;
			return new Response(
				stalledCancelBody(() => {
					cancelled = true;
				}),
			);
		};
		const controller = new AbortController();
		const request = execute(
			{ url: "https://example.com/late" },
			controller.signal,
		);
		controller.abort(new Error("stop"));
		arrival.resolve();

		await assert.rejects(
			request,
			(error: ToolError) => error.errorType === "aborted",
		);
		assert.equal(cancelled, true);
	});

	it("does not await a stalled cancellation for an oversized response", async () => {
		let cancelled = false;
		globalThis.fetch = async () =>
			new Response(
				stalledCancelBody(() => {
					cancelled = true;
				}),
				{ headers: { "content-length": String(17 * 1024 * 1024) } },
			);

		const outcome = await settlesWithinTurns(
			execute({ url: "https://example.com/large" }),
		);
		assert.ok(outcome instanceof Error, `expected rejection, got ${outcome}`);
		assert.match(outcome.message, /exceeds maximum/);
		assert.equal(cancelled, true);
	});

	it("reports caller cancellation separately from timeout", async () => {
		globalThis.fetch = async (_input, init) => {
			init?.signal?.throwIfAborted();
			throw new Error("Expected an aborted signal");
		};
		const controller = new AbortController();
		controller.abort(new Error("stop"));

		await assert.rejects(
			execute({ url: "https://example.com" }, controller.signal),
			(error: ToolError) => error.errorType === "aborted",
		);
	});
});
