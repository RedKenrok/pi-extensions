import assert from "node:assert/strict";
import test from "node:test";
import type { AuthResult } from "../src/auth.ts";
import {
	CODEX_CLIENT_VERSION,
	CODEX_MODELS_URL,
	CODEX_RESPONSES_URL,
	CodexClient,
	MAX_CATALOG_BYTES,
	MAX_SSE_FRAME_BYTES,
	MAX_STREAM_BYTES,
	ResearchError,
} from "../src/codex.ts";

const auth: Extract<AuthResult, { kind: "ready" }> = {
	kind: "ready",
	accessToken: "dummy-access-token",
	accountId: "dummy-account-id",
};

function event(type: string, data: unknown, crlf = false): string {
	const newline = crlf ? "\r\n" : "\n";
	return `event: ${type}${newline}data: ${JSON.stringify(data)}${newline}${newline}`;
}

function streamResponse(
	text: string,
	chunks?: number[],
	init: ResponseInit = {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	},
): Response {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= bytes.length) return controller.close();
				const size = chunks?.shift() ?? bytes.length;
				controller.enqueue(bytes.slice(offset, offset + size));
				offset += size;
			},
		}),
		init,
	);
}

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
	await new Promise((resolve) => setTimeout(resolve, 0));
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
	await new Promise((resolve) => setTimeout(resolve, 0));
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
		await new Promise((resolve) => setTimeout(resolve, 0));
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
	assert.equal(
		calls,
		3,
		"explicit choices are revalidated against the catalog",
	);
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
