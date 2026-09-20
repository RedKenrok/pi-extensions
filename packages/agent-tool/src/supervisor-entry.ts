import { timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { parseArgs } from "node:util";
import {
	type IpcRequest,
	PROTOCOL_VERSION,
	pathsFor,
	readFrames,
	SUPERVISOR_API_VERSION,
	SUPERVISOR_ENTRY_PATH,
} from "./ipc.ts";
import { Supervisor } from "./supervisor.ts";

const { values } = parseArgs({ options: { "agent-dir": { type: "string" } } });
if (!values["agent-dir"]) throw new Error("--agent-dir is required");
const paths = pathsFor(values["agent-dir"]);
const token = readFileSync(paths.tokenPath, "utf8").trim();
writeFileSync(paths.pidPath, `${process.pid}\n`, { mode: 0o600 });
const positive = (name: string, fallback: number) => {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : fallback;
};
const supervisor = new Supervisor({
	agentDir: values["agent-dir"],
	stateDir: paths.stateDir,
	socketPath: paths.socketPath,
	tokenPath: paths.tokenPath,
	maxRunning: positive("PI_TOOLS_MAX_RUNNING", 16),
	maxPerScope: positive("PI_TOOLS_MAX_PER_SCOPE", 16),
	maxOutstandingPerParent: positive("PI_TOOLS_MAX_PER_PARENT", 32),
	maxQueued: positive("PI_TOOLS_MAX_QUEUED", 128),
});
await supervisor.start();
const sockets = new Set<import("node:net").Socket>();
const server = createServer((socket) => {
	sockets.add(socket);
	socket.once("close", () => sockets.delete(socket));
	readFrames(socket, async (raw) => {
		const request = raw as IpcRequest;
		if (request.version !== PROTOCOL_VERSION)
			throw Object.assign(new Error("IPC protocol version mismatch"), {
				code: "protocol_mismatch",
			});
		const supplied = Buffer.from(request.token ?? "");
		const expected = Buffer.from(token);
		if (
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		)
			throw Object.assign(new Error("IPC authentication failed"), {
				code: "unauthorized",
			});
		switch (request.method) {
			case "ping":
				return {
					status: "pong",
					apiVersion: SUPERVISOR_API_VERSION,
					pid: process.pid,
					entryPath: SUPERVISOR_ENTRY_PATH,
				};
			case "tool":
				return await supervisor.handle(
					request.params as Parameters<Supervisor["handle"]>[0],
				);
			case "worker_event":
				return await supervisor.workerEvent(
					request.params as Parameters<Supervisor["workerEvent"]>[0],
				);
			case "worker_poll":
				return supervisor.workerPoll(
					request.params as Parameters<Supervisor["workerPoll"]>[0],
				);
			case "parent_input":
				return supervisor.parentInput(
					request.params as Parameters<Supervisor["parentInput"]>[0],
				);
			case "parent_attach":
				return supervisor.parentAttach(
					request.params as Parameters<Supervisor["parentAttach"]>[0],
				);
			case "parent_detach":
				return supervisor.parentDetach(
					request.params as Parameters<Supervisor["parentDetach"]>[0],
				);
			case "headless_event":
				return supervisor.headlessEvent(
					request.params as Parameters<Supervisor["headlessEvent"]>[0],
				);
			case "drain_outbox":
				return supervisor.drainOutbox(
					request.params as Parameters<Supervisor["drainOutbox"]>[0],
				);
			case "ack_outbox":
				return supervisor.ackOutbox(
					request.params as Parameters<Supervisor["ackOutbox"]>[0],
				);
			default:
				throw Object.assign(new Error(`Unknown method ${request.method}`), {
					code: "method_not_found",
				});
		}
	});
});
server.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code === "EADDRINUSE") process.exit(0);
	throw error;
});
server.listen(paths.socketPath, () => {
	if (process.platform !== "win32") chmodSync(paths.socketPath, 0o600);
});
let shuttingDown = false;
const shutdown = () => {
	if (shuttingDown) return;
	shuttingDown = true;
	server.close();
	for (const socket of sockets) socket.destroy();
	if (process.platform !== "win32")
		try {
			unlinkSync(paths.socketPath);
		} catch {
			/* absent */
		}
	try {
		unlinkSync(paths.pidPath);
	} catch {
		/* absent */
	}
	supervisor.stop();
	process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
