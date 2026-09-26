import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import fetchTool from "../src/fetch.ts";

// These run against Node's real fetch (undici) so redirect handling, content
// decoding, and streaming behave exactly as in production.

type ToolError = Error & { errorType?: string };

const GZIP_BOMB = gzipSync(Buffer.alloc(17 * 1024 * 1024));

let server: Server;
let origin: string;

before(async () => {
	server = createServer((request, response) => {
		switch (request.url) {
			case "/redirect":
				response.writeHead(302, { location: "/final" });
				response.end();
				return;
			case "/final":
				response.writeHead(200, { "content-type": "text/plain" });
				response.end("done");
				return;
			case "/chunked":
				response.writeHead(200, { "content-type": "application/json" });
				response.write('{ "items": [');
				response.write(" 1, 2,");
				response.end(" 3 ] }");
				return;
			case "/gzip-bomb":
				response.writeHead(200, {
					"content-type": "application/octet-stream",
					"content-encoding": "gzip",
					"content-length": String(GZIP_BOMB.byteLength),
				});
				response.end(GZIP_BOMB);
				return;
			case "/slow":
				response.writeHead(200, { "content-type": "text/plain" });
				response.write("partial");
				// Never ends; the client deadline must stop the read.
				return;
			default:
				response.writeHead(404);
				response.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

const execute = (path: string, params: object = {}) =>
	fetchTool().execute(
		"call",
		{ url: `${origin}${path}`, ...params },
		undefined,
	);

describe("fetch against a local HTTP server", () => {
	it("follows redirects and reports both URLs", async () => {
		const result = await execute("/redirect");
		assert.equal(result.details.status, 200);
		assert.equal(result.details.url, `${origin}/final`);
		assert.equal(result.details.originalUrl, `${origin}/redirect`);
	});

	it("rejects redirects in error mode", async () => {
		await assert.rejects(
			execute("/redirect", { redirect: "error" }),
			(error: ToolError) => error.errorType === "fetch",
		);
	});

	it("returns the redirect itself in manual mode", async () => {
		const result = await execute("/redirect", { redirect: "manual" });
		assert.equal(result.details.status, 302);
		assert.equal(result.details.headers?.location, "/final");
	});

	it("assembles chunked responses without a declared length", async () => {
		const result = await execute("/chunked");
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /\{"items":\[1,2,3\]\}$/);
	});

	it("limits the decoded size even when the compressed length is small", async () => {
		await assert.rejects(
			execute("/gzip-bomb"),
			(error: ToolError) => error.errorType === "size_limit",
		);
	});

	it("times out a body that never finishes", async () => {
		await assert.rejects(
			execute("/slow", { timeout: 200 }),
			(error: ToolError) => error.errorType === "timeout",
		);
	});
});
