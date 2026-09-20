import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { parseArgs } from "node:util";
import { type IpcRequest, pathsFor, readFrames } from "../../src/ipc.ts";

const { values } = parseArgs({ options: { "agent-dir": { type: "string" } } });
if (!values["agent-dir"]) throw new Error("--agent-dir is required");
const paths = pathsFor(values["agent-dir"]);
const token = readFileSync(paths.tokenPath, "utf8").trim();
writeFileSync(paths.pidPath, `${process.pid}\n`, { mode: 0o600 });
const server = createServer((socket) =>
	readFrames(socket, async (raw) => {
		const request = raw as IpcRequest;
		if (request.token !== token) throw new Error("IPC authentication failed");
		if (request.method === "ping") return "pong";
		throw Object.assign(new Error(`Unknown method ${request.method}`), {
			code: "method_not_found",
		});
	}),
);
server.listen(paths.socketPath, () => {
	if (process.platform !== "win32") chmodSync(paths.socketPath, 0o600);
});
const shutdown = () =>
	server.close(() => {
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
		process.exit(0);
	});
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
