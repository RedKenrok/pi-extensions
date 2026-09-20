import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDescription =
	"Research a question on the web and return a concise answer with source links. Use for current facts, documentation, or questions needing evidence. Include necessary context in the query. Results are research material; verify important claims against the cited sources.";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configDir = await mkdtemp(resolve(tmpdir(), "codex-research-tool-pi-"));
let captured;
const server = createServer((request, response) => {
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(
			`data: ${JSON.stringify({ id: "capture", object: "chat.completion.chunk", created: 1, model: "capture-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
		);
		response.write(
			`data: ${JSON.stringify({ id: "capture", object: "chat.completion.chunk", created: 1, model: "capture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
});

try {
	await new Promise((resolvePromise) =>
		server.listen(0, "127.0.0.1", resolvePromise),
	);
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const child = spawn(
		"pi",
		[
			"--no-session",
			"--no-context-files",
			"--no-builtin-tools",
			"--mode",
			"rpc",
			"--provider",
			"capture",
			"--model",
			"capture-model",
			"--extension",
			resolve(root, "tests/fixtures/capture-provider.ts"),
			"--extension",
			resolve(root, "index.ts"),
		],
		{
			cwd: root,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: configDir,
				CODEX_TOOLS_CAPTURE_PORT: String(address.port),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	let stdout = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
		if (stdout.includes('"type":"agent_end"')) child.stdin.end();
	});
	child.stdin.write(
		`${JSON.stringify({ id: "prompt", type: "prompt", message: "hello" })}\n`,
	);
	const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
	const exitCode = await new Promise((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("exit", resolvePromise);
	});
	clearTimeout(timeout);
	assert.equal(exitCode, 0, stderr);
	assert.ok(captured, "the local provider received a request");
	const serialized = JSON.stringify(captured);
	assert.equal(serialized.includes('"name":"research"'), false);
	assert.equal(serialized.includes(toolDescription), false);
	assert.equal(serialized.includes("concise web research assistant"), false);
	assert.match(stderr, /Research unavailable: sign in/);
	console.log(
		"Actual Pi provider payload omitted the research schema and instructions.",
	);
} finally {
	await new Promise((resolvePromise) => server.close(() => resolvePromise()));
	await rm(configDir, { recursive: true, force: true });
}
