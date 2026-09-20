import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { sanitize } from "./availability.ts";
import { ipcCall } from "./ipc.ts";
import type { HeadlessConfig } from "./types.ts";

export async function runHeadless(configPath: string): Promise<void> {
	const config = JSON.parse(readFileSync(configPath, "utf8")) as HeadlessConfig;
	try {
		unlinkSync(configPath);
	} catch {
		/* restrictive file is harmless if cleanup races */
	}
	const token = readFileSync(config.tokenPath, "utf8").trim();
	const report = async (type: "complete" | "failed", message?: string) =>
		await ipcCall(
			config.socketPath,
			token,
			"headless_event",
			{
				idleId: config.idleId,
				headlessRunId: config.headlessRunId,
				parentSessionId: config.parentSessionId,
				type,
				...(message ? { message } : {}),
			},
			10_000,
		);
	let session:
		| Awaited<ReturnType<typeof createAgentSession>>["session"]
		| undefined;
	try {
		const runtime = await ModelRuntime.create({
			authPath: join(config.agentDir, "auth.json"),
			modelsPath: join(config.agentDir, "models.json"),
			modelsStorePath: join(config.agentDir, "models-store.json"),
			allowModelNetwork: false,
		});
		const model = runtime.getModel(config.model.provider, config.model.id);
		if (!model)
			throw new Error(
				`Saved parent model ${config.model.provider}/${config.model.id} is unavailable`,
			);
		const available = await runtime.getAvailable(model.provider, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!available.some((item) => item.id === model.id))
			throw new Error(
				`Authentication is unavailable for ${model.provider}/${model.id}`,
			);
		const settings = SettingsManager.create(config.cwd, config.agentDir);
		settings.applyOverrides({ retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: config.cwd,
			agentDir: config.agentDir,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		const sessionManager = SessionManager.open(
			config.sessionFile,
			join(config.stateDir, "headless-sessions"),
			config.cwd,
		);
		({ session } = await createAgentSession({
			cwd: config.cwd,
			agentDir: config.agentDir,
			modelRuntime: runtime,
			model,
			thinkingLevel: config.reasoning,
			tools: [],
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager,
		}));
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			void session?.abort();
		}, 10 * 60_000);
		timeout.unref();
		try {
			await session.prompt(config.prompt, { expandPromptTemplates: false });
		} finally {
			clearTimeout(timeout);
		}
		if (timedOut)
			throw new Error("Headless continuation timed out after 10 minutes");
		session.dispose();
		await settings.flush();
		await report("complete");
	} catch (error) {
		session?.dispose();
		try {
			await report(
				"failed",
				sanitize(error instanceof Error ? error.message : String(error)),
			);
		} catch {
			/* supervisor will mark an early exit */
		}
		process.exitCode = 1;
	}
}
