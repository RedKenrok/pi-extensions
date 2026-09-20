import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	ensureSecret,
	ensureSupervisor,
	ipcCall,
	MAX_IPC_FRAME_SIZE,
	pathsFor,
	SUPERVISOR_API_VERSION,
	SUPERVISOR_ENTRY_PATH,
} from "../src/ipc.ts";

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null) return;
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("supervisor exposes only authenticated local IPC and survives a real process handshake", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-tools-ipc-"));
	const paths = pathsFor(agentDir);
	const token = ensureSecret(paths.tokenPath);
	const entry = fileURLToPath(
		new URL("../src/supervisor-entry.ts", import.meta.url),
	);
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", entry, "--agent-dir", agentDir],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	try {
		const deadline = Date.now() + 5000;
		let ready = false;
		while (Date.now() < deadline) {
			try {
				const response = (await ipcCall(
					paths.socketPath,
					token,
					"ping",
					undefined,
					250,
				)) as { status?: string; apiVersion?: number };
				ready =
					response.status === "pong" &&
					response.apiVersion === SUPERVISOR_API_VERSION;
			} catch {
				/* starting */
			}
			if (ready || child.exitCode !== null) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (!ready && /listen EPERM/.test(stderr)) {
			t.skip("sandbox disallows Unix-domain socket listeners");
			return;
		}
		assert.equal(ready, true, stderr);
		await assert.rejects(
			() => ipcCall(paths.socketPath, "wrong-token", "ping", undefined, 500),
			/authentication failed/,
		);

		const oversizedResponse = await new Promise<string>((resolve, reject) => {
			const socket = createConnection(paths.socketPath);
			let response = "";
			socket.once("connect", () =>
				socket.write("x".repeat(MAX_IPC_FRAME_SIZE + 1)),
			);
			socket.on("data", (chunk) => {
				response += chunk.toString("utf8");
			});
			socket.once("end", () => resolve(response));
			socket.once("error", reject);
		});
		assert.match(oversizedResponse, /frame_too_large/);
		await assert.rejects(
			() =>
				ipcCall(
					paths.socketPath,
					token,
					"ping",
					"x".repeat(MAX_IPC_FRAME_SIZE + 1),
					500,
				),
			/request exceeds .* IPC frame limit/,
		);
	} finally {
		const exited =
			child.exitCode === null
				? new Promise<void>((resolve) => child.once("exit", () => resolve()))
				: Promise.resolve();
		child.kill("SIGTERM");
		await exited;
	}
});

test("ensureSupervisor replaces a responsive supervisor with an incompatible API", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-tools-legacy-ipc-"));
	const paths = pathsFor(agentDir);
	const token = ensureSecret(paths.tokenPath);
	const entry = fileURLToPath(
		new URL("fixtures/legacy-supervisor.ts", import.meta.url),
	);
	const legacy = spawn(
		process.execPath,
		["--experimental-strip-types", entry, "--agent-dir", agentDir],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	legacy.stderr?.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	let replacementPid = 0;
	try {
		const deadline = Date.now() + 5000;
		let ready = false;
		while (Date.now() < deadline) {
			try {
				ready =
					(await ipcCall(paths.socketPath, token, "ping", undefined, 250)) ===
					"pong";
			} catch {
				/* starting */
			}
			if (ready || legacy.exitCode !== null) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (!ready && /listen EPERM/.test(stderr)) {
			t.skip("sandbox disallows Unix-domain socket listeners");
			return;
		}
		assert.equal(ready, true, stderr);
		await ensureSupervisor(agentDir);
		const response = (await ipcCall(paths.socketPath, token, "ping")) as {
			status?: string;
			apiVersion?: number;
			entryPath?: string;
			pid?: number;
		};
		replacementPid = response.pid ?? 0;
		assert.equal(response.status, "pong");
		assert.equal(response.apiVersion, SUPERVISOR_API_VERSION);
		assert.equal(response.entryPath, SUPERVISOR_ENTRY_PATH);
		assert.notEqual(replacementPid, legacy.pid);
		await waitForExit(legacy);
	} finally {
		if (legacy.exitCode === null) {
			legacy.kill("SIGTERM");
			await waitForExit(legacy);
		}
		if (replacementPid > 0)
			try {
				process.kill(replacementPid, "SIGTERM");
			} catch {
				/* already stopped */
			}
	}
});
