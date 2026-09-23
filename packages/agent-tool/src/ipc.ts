import { spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { sanitize } from "./availability.ts";
import { newSecret, stableHash } from "./ids.ts";
import { prepareStateDirectory } from "./store.ts";

export const PROTOCOL_VERSION = 1;
export const SUPERVISOR_API_VERSION = 9;
export const SUPERVISOR_ENTRY_PATH = fileURLToPath(
	new URL("./supervisor-entry.ts", import.meta.url),
);
export const MAX_IPC_FRAME_SIZE = 1024 * 1024;
export interface IpcRequest {
	id: string;
	token: string;
	version: 1;
	method: string;
	params?: unknown;
}
export interface IpcResponse {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: { code: string; message: string; retryable: boolean };
}
export interface SupervisorPing {
	status: "pong";
	apiVersion: number;
	pid: number;
	entryPath: string;
}

export function pathsFor(agentDir: string) {
	const stateDir = join(agentDir, "agent-tool");
	const socketPath =
		process.platform === "win32"
			? `\\\\.\\pipe\\pi-tools-${stableHash(agentDir).slice(0, 24)}`
			: join(stateDir, "supervisor.sock");
	return {
		stateDir,
		socketPath,
		tokenPath: join(stateDir, "ipc-token"),
		statePath: join(stateDir, "state"),
		lockPath: join(stateDir, "startup.lock"),
		pidPath: join(stateDir, "supervisor.pid"),
	};
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function ensureSecret(tokenPath: string): string {
	mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
	if (!existsSync(tokenPath)) {
		const descriptor = openSync(tokenPath, "wx", 0o600);
		try {
			writeFileSync(descriptor, `${newSecret()}\n`, { encoding: "utf8" });
		} finally {
			closeSync(descriptor);
		}
	}
	chmodSync(tokenPath, 0o600);
	return readFileSync(tokenPath, "utf8").trim();
}

export async function ipcCall(
	socketPath: string,
	token: string,
	method: string,
	params?: unknown,
	timeoutMs = 5000,
): Promise<unknown> {
	return await new Promise((resolve, reject) => {
		const id = newSecret().slice(0, 16);
		const socket = createConnection(socketPath);
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Supervisor request timed out: ${method}`));
		}, timeoutMs);
		const finish = (error?: Error, value?: unknown) => {
			clearTimeout(timer);
			socket.destroy();
			error ? reject(error) : resolve(value);
		};
		socket.once("connect", () => {
			const frame = `${JSON.stringify({ id, token, version: PROTOCOL_VERSION, method, params } satisfies IpcRequest)}\n`;
			if (Buffer.byteLength(frame) > MAX_IPC_FRAME_SIZE)
				return finish(
					new Error(
						`Supervisor request exceeds ${MAX_IPC_FRAME_SIZE} byte IPC frame limit`,
					),
				);
			socket.write(frame);
		});
		socket.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			if (Buffer.byteLength(buffer) > MAX_IPC_FRAME_SIZE)
				return finish(
					new Error(
						`Supervisor response exceeds ${MAX_IPC_FRAME_SIZE} byte IPC frame limit`,
					),
				);
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(buffer.slice(0, newline)) as IpcResponse;
				if (response.id !== id)
					return finish(new Error("Supervisor response ID mismatch"));
				if (!response.ok) {
					const error = new Error(
						response.error?.message ?? "Supervisor request failed",
					) as Error & { code?: string; retryable?: boolean };
					if (response.error?.code) error.code = response.error.code;
					if (response.error?.retryable !== undefined)
						error.retryable = response.error.retryable;
					return finish(error);
				}
				finish(undefined, response.result);
			} catch (error) {
				finish(error as Error);
			}
		});
		socket.once("error", (error) => finish(error));
	});
}

async function ping(
	socketPath: string,
	token: string,
): Promise<"compatible" | "incompatible" | "absent"> {
	try {
		const response = await ipcCall(socketPath, token, "ping", undefined, 500);
		return typeof response === "object" &&
			response !== null &&
			(response as SupervisorPing).status === "pong" &&
			(response as SupervisorPing).apiVersion === SUPERVISOR_API_VERSION &&
			(response as SupervisorPing).entryPath === SUPERVISOR_ENTRY_PATH
			? "compatible"
			: "incompatible";
	} catch {
		return "absent";
	}
}

async function stopIncompatibleSupervisor(pidPath: string): Promise<void> {
	let pid = 0;
	try {
		pid = Number(readFileSync(pidPath, "utf8").trim());
	} catch {
		/* absent */
	}
	if (!Number.isInteger(pid) || pid <= 0 || !processAlive(pid)) return;
	process.kill(pid, "SIGTERM");
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline && processAlive(pid))
		await new Promise((resolve) => setTimeout(resolve, 25));
	if (processAlive(pid))
		throw new Error(`Incompatible agent supervisor ${pid} did not stop`);
}

export async function ensureSupervisor(
	agentDir: string,
): Promise<{ socketPath: string; token: string; stateDir: string }> {
	const paths = pathsFor(agentDir);
	mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
	prepareStateDirectory(paths.statePath);
	const token = ensureSecret(paths.tokenPath);
	if ((await ping(paths.socketPath, token)) === "compatible")
		return { socketPath: paths.socketPath, token, stateDir: paths.stateDir };
	let ownsLock = false;
	try {
		const fd = openSync(paths.lockPath, "wx", 0o600);
		writeFileSync(fd, String(Date.now()));
		closeSync(fd);
		ownsLock = true;
	} catch {
		try {
			const age =
				Date.now() - Number(readFileSync(paths.lockPath, "utf8").trim() || 0);
			if (age > 30_000) unlinkSync(paths.lockPath);
		} catch {
			/* another starter owns it */
		}
	}
	if (ownsLock) {
		const status = await ping(paths.socketPath, token);
		if (status === "compatible") {
			try {
				unlinkSync(paths.lockPath);
			} catch {
				/* absent */
			}
			return { socketPath: paths.socketPath, token, stateDir: paths.stateDir };
		}
		if (status === "incompatible")
			await stopIncompatibleSupervisor(paths.pidPath);
		let existingPid = 0;
		try {
			existingPid = Number(readFileSync(paths.pidPath, "utf8").trim());
		} catch {
			/* absent */
		}
		if (existingPid > 0 && processAlive(existingPid)) {
			try {
				unlinkSync(paths.lockPath);
			} catch {
				/* absent */
			}
			ownsLock = false;
		}
	}
	if (ownsLock) {
		if (process.platform !== "win32")
			try {
				unlinkSync(paths.socketPath);
			} catch {
				/* absent */
			}
		const child = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				SUPERVISOR_ENTRY_PATH,
				"--agent-dir",
				agentDir,
			],
			{ detached: true, stdio: "ignore" },
		);
		child.unref();
	}
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if ((await ping(paths.socketPath, token)) === "compatible") {
			if (ownsLock)
				try {
					unlinkSync(paths.lockPath);
				} catch {
					/* absent */
				}
			return { socketPath: paths.socketPath, token, stateDir: paths.stateDir };
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (ownsLock)
		try {
			unlinkSync(paths.lockPath);
		} catch {
			/* absent */
		}
	throw new Error("Agent supervisor did not become ready");
}

export function readFrames(
	socket: Socket,
	onFrame: (frame: unknown) => Promise<unknown>,
): void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let oversized = false;
	socket.on("data", (chunk) => {
		if (oversized) return;
		buffer += decoder.write(chunk);
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (Buffer.byteLength(line) > MAX_IPC_FRAME_SIZE) {
				oversized = true;
				socket.end(
					`${JSON.stringify({ id: "?", ok: false, error: { code: "frame_too_large", message: `IPC frame exceeds ${MAX_IPC_FRAME_SIZE} byte limit`, retryable: false } } satisfies IpcResponse)}\n`,
				);
				return;
			}
			if (!line) continue;
			void (async () => {
				let request: IpcRequest;
				try {
					request = JSON.parse(line) as IpcRequest;
				} catch {
					socket.write(
						`${JSON.stringify({ id: "?", ok: false, error: { code: "invalid_json", message: "Invalid JSON", retryable: false } })}\n`,
					);
					return;
				}
				try {
					const result = await onFrame(request);
					socket.write(
						`${JSON.stringify({ id: request.id, ok: true, result } satisfies IpcResponse)}\n`,
					);
				} catch (caught) {
					const error = caught as Error & {
						code?: string;
						retryable?: boolean;
					};
					socket.write(
						`${JSON.stringify({ id: request.id, ok: false, error: { code: error.code ?? "internal_error", message: sanitize(error.message), retryable: Boolean(error.retryable) } } satisfies IpcResponse)}\n`,
					);
				}
			})();
		}
		if (Buffer.byteLength(buffer) > MAX_IPC_FRAME_SIZE) {
			oversized = true;
			socket.end(
				`${JSON.stringify({ id: "?", ok: false, error: { code: "frame_too_large", message: `IPC frame exceeds ${MAX_IPC_FRAME_SIZE} byte limit`, retryable: false } } satisfies IpcResponse)}\n`,
			);
		}
	});
}
