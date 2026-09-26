import assert from "node:assert/strict";
import test from "node:test";
import { nextTurn } from "../../../test-support/async.ts";
import {
	sseEvent as event,
	chunkedResponse as streamResponse,
} from "../../../test-support/streams.ts";
import type { ReadyAuth } from "../src/auth.ts";
import {
	CODEX_CLIENT_VERSION,
	CODEX_MODELS_URL,
	CODEX_RESPONSES_URL,
	CodexClient,
	citationRange,
	MAX_CATALOG_BYTES,
	MAX_SSE_FRAME_BYTES,
	MAX_STREAM_BYTES,
	ResearchError,
	retryAfterSeconds,
	terminalError,
} from "../src/codex.ts";
import { PACKAGE_VERSION } from "../src/util.ts";

const auth: ReadyAuth = {
	kind: "ready",
	accessToken: "dummy-access-token",
	accountId: "dummy-account-id",
};

function normalSse(answer = "A fact."): string {
	return [
		event("response.created", { response: { id: "response-1" } }),
		event("response.output_text.delta", { delta: "streamed duplicate" }),
		event("response.output_item.done", {
			item: { id: "search-1", type: "web_search_call", status: "completed" },
		}),
		event("response.output_item.done", {
			item: {
				id: "message-1",
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: answer,
						annotations: [
							{
								type: "url_citation",
								title: "Source",
								url: "https://example.com/a",
								start_index: 0,
								end_index: 6,
							},
							{
								type: "url_citation",
								title: "Duplicate",
								url: "https://example.com/a",
							},
							{ type: "url_citation", title: "Unsafe", url: "file:///secret" },
						],
					},
				],
			},
		}),
		event("response.completed", {
			response: { id: "response-1", status: "completed" },
		}),
	].join("");
}

test("sends the fixed research payload and both required auth headers exactly once", async () => {
	let calls = 0;
	let capturedUrl = "";
	let captured: RequestInit | undefined;
	const client = new CodexClient({
		fetch: async (input, init) => {
			calls += 1;
			capturedUrl = input.toString();
			captured = init;
			return streamResponse(normalSse());
		},
	});
	const result = await client.runResearch({
		query: "question",
		auth,
		model: "codex-model",
		effort: "high",
	});
	assert.equal(calls, 1);
	assert.equal(capturedUrl, CODEX_RESPONSES_URL);
	assert.equal(captured?.redirect, "manual");
	const headers = new Headers(captured?.headers);
	assert.equal(headers.get("authorization"), "Bearer dummy-access-token");
	assert.equal(headers.get("chatgpt-account-id"), "dummy-account-id");
	assert.equal(headers.get("originator"), "pi");
	const payload = JSON.parse(String(captured?.body));
	assert.equal(payload.input[0].content[0].text, "question");
	assert.deepEqual(payload.reasoning, { effort: "high" });
	assert.deepEqual(payload.tools, [
		{
			type: "web_search",
			external_web_access: true,
			search_context_size: "medium",
		},
	]);
	assert.equal(payload.tool_choice, "required");
	assert.equal(payload.store, false);
	assert.equal(payload.stream, true);
	assert.equal(payload.input.length, 1);
	assert.equal(result.answer, "A fact.");
	assert.equal(result.answer.includes("streamed duplicate"), false);
	assert.equal(result.citations.length, 1);
	assert.equal(result.effort, "high");
});

test("handles split Unicode, CRLF, multiline data, and terminal-envelope fallback", async () => {
	const terminal = {
		type: "response.completed",
		response: {
			id: "terminal",
			status: "completed",
			output: [
				{ id: "s", type: "web_search_call" },
				{
					id: "m",
					type: "message",
					role: "assistant",
					content: [
						{ type: "output_text", text: "Unicode 🧪 answer", annotations: [] },
					],
				},
			],
		},
	};
	const json = JSON.stringify(terminal);
	const split = json.indexOf('"response"');
	const sse = `data: ${json.slice(0, split)}\r\ndata: ${json.slice(split)}\r\n\r\n`;
	const client = new CodexClient({
		fetch: async () => streamResponse(sse, [1, 2, 3, 4, 5, 6]),
	});
	const result = await client.runResearch({ query: "q", auth, model: "m" });
	assert.equal(result.answer, "Unicode 🧪 answer");
	assert.equal(result.responseId, "terminal");
});

test("recognizes explicit web-search lifecycle events", async () => {
	const sse = [
		event("response.web_search_call.searching", {
			type: "response.web_search_call.searching",
			item_id: "search-event",
		}),
		event("response.output_item.done", {
			item: {
				id: "message",
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "answer" }],
			},
		}),
		event("response.completed", { response: { status: "completed" } }),
	].join("");
	const client = new CodexClient({ fetch: async () => streamResponse(sse) });
	const result = await client.runResearch({ query: "q", auth, model: "m" });
	assert.equal(result.searchActivity, 1);
});

test("rejects malformed, incomplete, empty, and search-less streams", async (t) => {
	const fixtures: Array<[string, string, string]> = [
		[
			"malformed",
			"event: response.created\ndata: {nope}\n\n",
			"backend_incompatible",
		],
		[
			"premature EOF",
			event("response.created", { response: { id: "x" } }),
			"backend_incompatible",
		],
		[
			"empty",
			event("response.completed", {
				response: {
					status: "completed",
					output: [{ id: "s", type: "web_search_call" }],
				},
			}),
			"backend_incompatible",
		],
		[
			"no search",
			event("response.completed", {
				response: {
					status: "completed",
					output: [
						{
							id: "m",
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "answer" }],
						},
					],
				},
			}),
			"backend_incompatible",
		],
		[
			"failed event",
			event("response.failed", {
				response: {
					error: { code: "server_error", message: "raw secret details" },
				},
			}),
			"network",
		],
	];
	for (const [name, fixture, expectedCode] of fixtures) {
		await t.test(name, async () => {
			const client = new CodexClient({
				fetch: async () => streamResponse(fixture),
			});
			await assert.rejects(
				client.runResearch({ query: "q", auth, model: "m" }),
				(error: unknown) =>
					error instanceof ResearchError &&
					error.code === expectedCode &&
					!error.message.includes("raw secret"),
			);
		});
	}
});

test("enforces individual-frame and total-stream byte limits", async (t) => {
	await t.test("frame", async () => {
		const huge = `data: ${"x".repeat(MAX_SSE_FRAME_BYTES + 1)}\n\n`;
		const client = new CodexClient({ fetch: async () => streamResponse(huge) });
		await assert.rejects(
			client.runResearch({ query: "q", auth, model: "m" }),
			ResearchError,
		);
	});
	await t.test("stream", async () => {
		const frame = `: ${"x".repeat(200_000)}\n\n`;
		const huge = frame.repeat(Math.ceil(MAX_STREAM_BYTES / frame.length) + 1);
		const client = new CodexClient({
			fetch: async () => streamResponse(huge, Array(20).fill(200_000)),
		});
		await assert.rejects(
			client.runResearch({ query: "q", auth, model: "m" }),
			ResearchError,
		);
	});
});

test("classifies redirects and HTTP failures without reading or leaking bodies", async (t) => {
	for (const [status, code] of [
		[302, "backend_incompatible"],
		[401, "auth_required"],
		[403, "access_denied"],
		[429, "rate_limited"],
		[500, "network"],
	] as const) {
		await t.test(String(status), async () => {
			let calls = 0;
			const client = new CodexClient({
				fetch: async () => {
					calls += 1;
					return new Response("secret backend body", {
						status,
						headers: status === 429 ? { "retry-after": "12" } : {},
					});
				},
			});
			await assert.rejects(
				client.runResearch({ query: "q", auth, model: "m" }),
				(error: unknown) =>
					error instanceof ResearchError &&
					error.code === code &&
					!error.message.includes("secret backend body") &&
					(status !== 429 || error.retryAfterSeconds === 12),
			);
			assert.equal(calls, 1);
		});
	}
});

test("abort during a pending SSE read is classified promptly", async () => {
	const controller = new AbortController();
	const client = new CodexClient({
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start() {},
					cancel() {},
				}),
			),
	});
	const pending = client.runResearch({
		query: "q",
		auth,
		model: "m",
		signal: controller.signal,
	});
	await nextTurn();
	controller.abort();
	await assert.rejects(
		pending,
		(error: unknown) =>
			error instanceof ResearchError && error.code === "cancelled",
	);
});

test("a network rejection while reading the SSE stream remains retryable", async () => {
	const client = new CodexClient({
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.error(new Error("connection reset"));
					},
				}),
			),
	});
	await assert.rejects(
		client.runResearch({ query: "q", auth, model: "m" }),
		(error: unknown) => {
			assert.ok(error instanceof ResearchError);
			assert.equal(error.code, "network");
			assert.equal(error.retryable, true);
			return true;
		},
	);
});

test("terminal SSE event resolves without waiting for stream close and cancels reader", async () => {
	let cancelled = false;
	const prefix = new TextEncoder().encode(normalSse());
	let sent = false;
	const client = new CodexClient({
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (!sent) {
							sent = true;
							controller.enqueue(prefix);
						}
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	});
	const result = await Promise.race([
		client.runResearch({ query: "q", auth, model: "m" }),
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("hung")), 500),
		),
	]);
	assert.equal(result.answer, "A fact.");
	await nextTurn();
	assert.equal(cancelled, true);
});

test("maps aborts to cancellation", async () => {
	const controller = new AbortController();
	const client = new CodexClient({
		fetch: async (_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			}),
	});
	const pending = client.runResearch({
		query: "q",
		auth,
		model: "m",
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(
		pending,
		(error: unknown) =>
			error instanceof ResearchError && error.code === "cancelled",
	);
});

test("discovers and caches Luna per account when available", async () => {
	let calls = 0;
	const client = new CodexClient({
		fetch: async (input, init) => {
			calls += 1;
			const url = new URL(input.toString());
			assert.equal(`${url.origin}${url.pathname}`, CODEX_MODELS_URL);
			assert.equal(
				url.searchParams.get("client_version"),
				CODEX_CLIENT_VERSION,
			);
			assert.equal(init?.redirect, "manual");
			return Response.json({
				models: [
					{ slug: "first" },
					{ slug: "default", is_default: true },
					{ slug: "gpt-6-luna" },
				],
			});
		},
	});
	assert.equal(await client.selectModel(auth), "gpt-6-luna");
	assert.equal(await client.selectModel(auth), "gpt-6-luna");
	assert.equal(calls, 1);
});

test("falls back to the declared default model when Luna is unavailable", async () => {
	const client = new CodexClient({
		fetch: async () =>
			Response.json({
				models: [{ slug: "first" }, { slug: "default", is_default: true }],
			}),
	});
	assert.equal(await client.selectModel(auth), "default");
});

test("filters models explicitly marked incompatible with API research", async () => {
	const client = new CodexClient({
		fetch: async () =>
			Response.json({
				models: [
					{ slug: "not-api", supported_in_api: false, is_default: true },
					{ slug: "no-search", supports_search_tool: false },
					{ slug: "no-web-tool", web_search_tool_type: "none" },
					{ slug: "research-default", is_default: true },
				],
			}),
	});
	assert.equal(await client.selectModel(auth), "research-default");
	await assert.rejects(
		client.selectModel(auth, undefined, "no-search"),
		(error: unknown) =>
			error instanceof ResearchError && error.code === "invalid_input",
	);
});

test("model catalog has a 2 MiB bound and aborting a pending read releases its reader", async (t) => {
	await t.test("oversized", async () => {
		const client = new CodexClient({
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(MAX_CATALOG_BYTES + 1));
							controller.close();
						},
					}),
				),
		});
		await assert.rejects(
			client.selectModel(auth),
			(error: unknown) =>
				error instanceof ResearchError && error.code === "backend_incompatible",
		);
	});
	await t.test("pending abort", async () => {
		const controller = new AbortController();
		let cancelled = false;
		let response!: Response;
		const client = new CodexClient({
			fetch: async () => {
				response = new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true;
						},
					}),
				);
				return response;
			},
		});
		const pending = client.selectModel(auth, controller.signal);
		await nextTurn();
		controller.abort();
		await assert.rejects(
			pending,
			(error: unknown) =>
				error instanceof ResearchError && error.code === "cancelled",
		);
		assert.equal(cancelled, true);
		assert.equal(response.body?.locked, false);
	});
});

test("a network rejection while reading the model catalog remains retryable", async () => {
	const client = new CodexClient({
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.error(new Error("connection reset"));
					},
				}),
			),
	});
	await assert.rejects(client.selectModel(auth), (error: unknown) => {
		assert.ok(error instanceof ResearchError);
		assert.equal(error.code, "network");
		assert.equal(error.retryable, true);
		return true;
	});
});

test("classifies an empty compatible catalog as a client-version problem", async () => {
	const client = new CodexClient({
		fetch: async () => Response.json({ models: [] }),
	});
	await assert.rejects(client.selectModel(auth), (error: unknown) => {
		assert.ok(error instanceof ResearchError);
		assert.equal(error.code, "client_outdated");
		assert.match(error.message, /compatibility version may be outdated/);
		return true;
	});
});

test("accepts only an exact requested model available to the account", async () => {
	let calls = 0;
	const client = new CodexClient({
		fetch: async () => {
			calls += 1;
			return Response.json({
				models: [
					{ slug: "first", supported_reasoning_levels: ["low"] },
					{
						slug: "chosen",
						default_reasoning_level: "medium",
						supported_reasoning_levels: [
							{ effort: "low" },
							{ effort: "medium" },
							{ effort: "high" },
						],
					},
				],
			});
		},
	});
	assert.equal(
		await client.selectModel(auth, undefined, "chosen", "high"),
		"chosen",
	);
	await assert.rejects(
		client.selectModel(auth, undefined, "missing"),
		(error: unknown) => {
			assert.ok(error instanceof ResearchError);
			assert.equal(error.code, "invalid_input");
			assert.match(error.message, /chosen: low, medium \(default\), high/);
			assert.deepEqual(error.modelOptions?.[1], {
				id: "chosen",
				efforts: ["low", "medium", "high"],
				defaultEffort: "medium",
			});
			return true;
		},
	);
	await assert.rejects(
		client.selectModel(auth, undefined, "chosen", "xhigh"),
		(error: unknown) =>
			error instanceof ResearchError &&
			error.code === "invalid_input" &&
			/effort is not supported/.test(error.message),
	);
	assert.equal(calls, 1, "explicit choices are validated against the cache");
});

test("rejects malformed, empty, redirected, and failed model catalogs", async (t) => {
	for (const [name, response] of [
		["malformed", new Response("not json")],
		["empty", Response.json({ models: [] })],
		["redirect", new Response(null, { status: 302 })],
		["server", new Response("secret", { status: 503 })],
	] as const) {
		await t.test(name, async () => {
			const client = new CodexClient({ fetch: async () => response.clone() });
			await assert.rejects(client.selectModel(auth), ResearchError);
		});
	}
});

function completedWith(output: unknown[], extra = ""): string {
	return (
		extra +
		event("response.completed", {
			response: { id: "r", status: "completed", output },
		})
	);
}

const search = { id: "search", type: "web_search_call", status: "completed" };

function message(text: string, annotations: unknown[] = [], id?: string) {
	return {
		...(id ? { id } : {}),
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text, annotations }],
	};
}

test("classifies terminal error codes and message fallbacks", () => {
	for (const [data, code, retryable] of [
		[{ response: { error: { code: "server_error" } } }, "network", true],
		[{ error: { code: "Gateway-Timeout" } }, "network", true],
		[{ code: "token_expired" }, "auth_required", false],
		[{ error: { code: "permission_denied" } }, "access_denied", false],
		[{ error: { code: "quota_exceeded" } }, "rate_limited", true],
		[
			{ message: "Authentication required for this call" },
			"auth_required",
			false,
		],
		[{ error: { message: "Rate limit reached" } }, "rate_limited", true],
		[
			{ error: { code: "mystery", message: "anything" } },
			"backend_incompatible",
			false,
		],
	] as const) {
		const error = terminalError(data);
		assert.equal(error.code, code, JSON.stringify(data));
		assert.equal(error.retryable, retryable, JSON.stringify(data));
	}
});

test("parses every Retry-After form", () => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const at = (headers: Record<string, string>) =>
		retryAfterSeconds(new Response(null, { headers }), now);
	assert.equal(at({ "retry-after-ms": "1500" }), 2);
	assert.equal(at({ "retry-after-ms": "soon", "retry-after": "3" }), 3);
	assert.equal(at({ "retry-after": "Thu, 01 Jan 2026 00:00:10 GMT" }), 10);
	assert.equal(at({ "retry-after": "Wed, 31 Dec 2025 23:59:00 GMT" }), 0);
	assert.equal(at({ "retry-after": "never" }), undefined);
	assert.equal(at({}), undefined);
});

test("citation ranges follow the answer when leading whitespace is trimmed", async () => {
	const client = new CodexClient({
		fetch: async () =>
			streamResponse(
				completedWith([
					search,
					message("\n  Claim one. Rest.", [
						{
							type: "url_citation",
							url: "https://example.com/one",
							title: "One",
							start_index: 3,
							end_index: 13,
						},
						{
							type: "url_citation",
							url: "https://example.com/space",
							title: "Space",
							start_index: 0,
							end_index: 2,
						},
					]),
				]),
			),
	});
	const result = await client.runResearch({ query: "q", auth, model: "m" });
	assert.equal(result.answer, "Claim one. Rest.");
	assert.deepEqual(result.citations[0], {
		title: "One",
		url: "https://example.com/one",
		startIndex: 0,
		endIndex: 10,
	});
	assert.equal(result.answer.slice(0, 10), "Claim one.");
	assert.deepEqual(result.citations[1], {
		title: "Space",
		url: "https://example.com/space",
	});
});

test("a message streamed and repeated in the terminal output without ids is used once", async () => {
	const sse = completedWith(
		[search, message("Only once.")],
		event("response.output_item.done", { item: message("Only once.") }),
	);
	const client = new CodexClient({ fetch: async () => streamResponse(sse) });
	const result = await client.runResearch({ query: "q", auth, model: "m" });
	assert.equal(result.answer, "Only once.");
});

test("streamed text fallback drops citation ranges computed for other text", async () => {
	const sse = completedWith(
		[
			search,
			message("   ", [
				{
					type: "url_citation",
					url: "https://example.com/a",
					title: "A",
					start_index: 0,
					end_index: 2,
				},
			]),
		],
		event("response.output_text.delta", { delta: "Streamed answer." }),
	);
	const client = new CodexClient({ fetch: async () => streamResponse(sse) });
	const result = await client.runResearch({ query: "q", auth, model: "m" });
	assert.equal(result.answer, "Streamed answer.");
	assert.deepEqual(result.citations, [
		{ title: "A", url: "https://example.com/a" },
	]);
});

test("the model catalog is cached per account until it expires or is invalidated", async () => {
	let clock = 0;
	let calls = 0;
	const client = new CodexClient({
		now: () => clock,
		fetch: async () => {
			calls += 1;
			return Response.json({ models: [{ slug: "gpt-6-luna" }] });
		},
	});
	await client.selectModel(auth);
	await client.selectModel(auth, undefined, "gpt-6-luna");
	assert.equal(calls, 1);
	await client.selectModel({ ...auth, accountId: "other-account" });
	assert.equal(calls, 2, "another account has its own catalog");
	client.invalidateModel();
	await client.selectModel({ ...auth, accountId: "other-account" });
	assert.equal(calls, 3);
	clock += 5 * 60_000;
	await client.selectModel({ ...auth, accountId: "other-account" });
	assert.equal(calls, 4, "an expired catalog is fetched again");
});

test("requests identify the package version in the user agent", async () => {
	let userAgent: string | null = null;
	const client = new CodexClient({
		fetch: async (_input, init) => {
			userAgent = new Headers(init?.headers).get("user-agent");
			return streamResponse(normalSse());
		},
	});
	await client.runResearch({ query: "q", auth, model: "m" });
	assert.equal(userAgent, `pi codex-research-tool/${PACKAGE_VERSION}`);
});

// Parsing speed is covered by the scaling test of the shared SSE reader; this
// checks that single-byte chunks lose nothing.
test("a large frame delivered one byte at a time is parsed intact", async () => {
	const answer = "x".repeat(50_000);
	const sse = completedWith([search, message(answer)]);
	const client = new CodexClient({
		fetch: async () =>
			streamResponse(sse, Array(sse.length).fill(1) as number[]),
	});
	const result = await client.runResearch({ query: "q", auth, model: "m" });
	assert.equal(result.answer, answer);
});

test("separators split across chunk boundaries are still recognized", async () => {
	const sse = normalSse().replaceAll("\n\n", "\r\n\r\n");
	for (const size of [1, 2, 3, 5]) {
		const client = new CodexClient({
			fetch: async () =>
				streamResponse(sse, Array(sse.length).fill(size) as number[]),
		});
		const result = await client.runResearch({ query: "q", auth, model: "m" });
		assert.equal(result.answer, "A fact.");
	}
});

test("citation ranges are used as-is when the text has no astral characters", () => {
	assert.deepEqual(citationRange("A fact.", 0, 6, "https://e.com/"), {
		start: 0,
		end: 6,
	});
	assert.equal(citationRange("short", 0, 99, "https://e.com/"), undefined);
	assert.equal(citationRange("text", 3, 1, "https://e.com/"), undefined);
	assert.equal(citationRange("text", 0.5, 2, "https://e.com/"), undefined);
	assert.equal(
		citationRange("text", undefined, 2, "https://e.com/"),
		undefined,
	);
});

test("citation ranges after emoji resolve to whichever unit covers the cited link", () => {
	const url = "https://example.com/a";
	const link = `([example.com](${url}))`;
	const text = `\u{1F98A}\u{1F98A} Foxes are fast. ${link}`;
	const utf16Start = text.indexOf(link);
	const codePointStart = Array.from(text.slice(0, utf16Start)).length;
	const expected = { start: utf16Start, end: utf16Start + link.length };
	// Code units: the range already covers the link.
	assert.deepEqual(
		citationRange(text, utf16Start, utf16Start + link.length, url),
		expected,
	);
	// Code points: two fewer before the link, converted back to code units.
	assert.deepEqual(
		citationRange(text, codePointStart, codePointStart + link.length, url),
		expected,
	);
	// Neither reading covers the link: keep the JavaScript (UTF-16) reading.
	assert.deepEqual(citationRange(text, 0, 2, url), { start: 0, end: 2 });
	// A code-point range past the end of the text cannot be converted.
	assert.deepEqual(citationRange(text, 0, text.length, url), {
		start: 0,
		end: text.length,
	});
	assert.equal(citationRange(text, 0, text.length + 1, url), undefined);
});

test("a hostname match is enough when the link text shows only the domain", () => {
	const text = "\u{1F98A} Claim (www.example.com)";
	const start = Array.from(text).indexOf("(");
	const range = citationRange(
		text,
		start,
		start + 17,
		"https://www.example.com/deep/path",
	);
	assert.equal(
		range && text.slice(range.start, range.end),
		"(www.example.com)",
	);
	// An unparseable URL can only match literally, so the UTF-16 reading stays.
	assert.deepEqual(citationRange(text, 0, 1, "not a url"), {
		start: 0,
		end: 1,
	});
});
