import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function captureProvider(pi: ExtensionAPI): void {
	const port = process.env.CODEX_TOOLS_CAPTURE_PORT;
	if (!port) throw new Error("CODEX_TOOLS_CAPTURE_PORT is required");
	pi.registerProvider("capture", {
		name: "Capture",
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: "synthetic-test-key",
		api: "openai-completions",
		models: [
			{
				id: "capture-model",
				name: "Capture Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16_000,
				maxTokens: 1_000,
			},
		],
	});
}
