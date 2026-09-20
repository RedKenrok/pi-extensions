import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getSupportedThinkingLevels,
	Type,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "pi-tools-compat-"));
const cwd = join(root, "workspace");
await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
const faux = fauxProvider({
	provider: "pi-tools-faux",
	models: [{ id: "compat", reasoning: true }],
	tokensPerSecond: 10_000,
});
const runtime = await ModelRuntime.create({
	authPath: join(root, "auth.json"),
	modelsPath: null,
	modelsStorePath: join(root, "models-store.json"),
	refreshOnCreate: false,
});
runtime.registerNativeProvider(faux.provider);
const model = runtime.getModel("pi-tools-faux", "compat");
assert(model, "registered faux model is resolvable");
assert(
	getSupportedThinkingLevels(model).includes("high"),
	"reasoning support is model-derived",
);
const settings = SettingsManager.inMemory({ retry: { enabled: false } });

// Persistent create/open and literal transport.
faux.setResponses([fauxAssistantMessage("literal-ok")]);
const sessionDir = join(root, "sessions");
const firstManager = SessionManager.create(cwd, sessionDir, {
	id: "compat-session",
});
const first = await createAgentSession({
	cwd,
	agentDir: root,
	modelRuntime: runtime,
	model,
	thinkingLevel: "high",
	tools: [],
	noTools: "all",
	settingsManager: settings,
	sessionManager: firstManager,
});
const literal = "/not-a-command $" + "{HOME} {{template}}";
await first.session.prompt(literal, { expandPromptTemplates: false });
const sessionFile = first.session.sessionFile;
assert(sessionFile, "persistent SDK session exposes exact file");
const initialMessage = firstManager.buildSessionContext().messages[0];
assert(initialMessage?.role === "user");
assert(Array.isArray(initialMessage.content));
assert.equal(initialMessage.content[0]?.type, "text");
assert.equal(initialMessage.content[0]?.text, literal);
const originalId = first.session.sessionId;
first.session.dispose();
const reopenedManager = SessionManager.open(sessionFile, sessionDir, cwd);
faux.setResponses([fauxAssistantMessage("resume-ok")]);
const reopened = await createAgentSession({
	cwd,
	agentDir: root,
	modelRuntime: runtime,
	model,
	thinkingLevel: "high",
	tools: [],
	noTools: "all",
	settingsManager: settings,
	sessionManager: reopenedManager,
});
assert.equal(reopened.session.sessionId, originalId);
assert(reopened.session.messages.length >= 2);
await reopened.session.prompt("continue", { expandPromptTemplates: false });
reopened.session.dispose();

// Inline-only extension loading and a pre-dispatch gate.
let executions = 0;
let hookStarts = 0;
const gate: InlineExtension = {
	name: "compat-gate",
	factory: (pi) =>
		pi.on("tool_call", (event) => {
			hookStarts++;
			return {
				block: true,
				reason: `blocked ${event.toolName}`,
				terminate: true,
			};
		}),
};
const loader = new DefaultResourceLoader({
	cwd,
	agentDir: root,
	settingsManager: settings,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	extensionFactories: [gate],
});
await loader.reload();
assert.deepEqual(
	loader.getExtensions().extensions.map((extension) => extension.path),
	["<inline:compat-gate>"],
);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("effect", { value: "x" })),
]);
const gated = await createAgentSession({
	cwd,
	agentDir: root,
	modelRuntime: runtime,
	model,
	thinkingLevel: "off",
	tools: ["effect"],
	customTools: [
		{
			name: "effect",
			label: "Effect",
			description: "compat effect",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "ran" }], details: {} };
			},
		},
	],
	resourceLoader: loader,
	settingsManager: settings,
	sessionManager: SessionManager.inMemory(cwd),
});
await gated.session.prompt("call effect", { expandPromptTemplates: false });
assert.equal(hookStarts, 1);
assert.equal(executions, 0, "tool hook blocks before side effect dispatch");
gated.session.dispose();

// Parent-tool inheritance: extension tools can be loaded in the SDK worker, narrowed by name,
// and the recursive `agent` tool can be removed even when the same extension registers it.
const extensionDir = join(root, "extensions");
mkdirSync(extensionDir);
const extensionPath = join(extensionDir, "parent-tools.mjs");
const marker = join(root, "parent-tool-ran");
writeFileSync(
	extensionPath,
	`
  import { writeFileSync } from "node:fs";
  const parameters = { type: "object", properties: {}, additionalProperties: false };
  export default function (pi) {
    pi.registerTool({ name: "parent_tool", label: "Parent tool", description: "Compatibility tool", parameters,
      execute: async () => { writeFileSync(${JSON.stringify(marker)}, "ok"); return { content: [{ type: "text", text: "parent tool ok" }], details: {} }; } });
    pi.registerTool({ name: "agent", label: "Recursive agent", description: "Must be removed", parameters,
      execute: async () => ({ content: [{ type: "text", text: "bad" }], details: {} }) });
  }
`,
);
const inheritedLoader = new DefaultResourceLoader({
	cwd,
	agentDir: root,
	settingsManager: settings,
	additionalExtensionPaths: [extensionPath],
	noPromptTemplates: true,
	extensionsOverride: (base) => ({
		...base,
		extensions: base.extensions.flatMap((extension) => {
			const tools = new Map(
				[...extension.tools].filter(([name]) => name === "parent_tool"),
			);
			return tools.size ? [{ ...extension, tools }] : [];
		}),
	}),
});
await inheritedLoader.reload({ resolveProjectTrust: async () => true });
assert.deepEqual(
	[
		...inheritedLoader
			.getExtensions()
			.extensions.flatMap((extension) => [...extension.tools.keys()]),
	],
	["parent_tool"],
);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("parent_tool", {})),
	fauxAssistantMessage("inherited-tool-ok"),
]);
const inherited = await createAgentSession({
	cwd,
	agentDir: root,
	modelRuntime: runtime,
	model,
	thinkingLevel: "off",
	tools: ["parent_tool"],
	resourceLoader: inheritedLoader,
	settingsManager: settings,
	sessionManager: SessionManager.inMemory(cwd),
});
assert.deepEqual(inherited.session.getActiveToolNames(), ["parent_tool"]);
await inherited.session.prompt("use the inherited parent tool", {
	expandPromptTemplates: false,
});
assert.equal(
	existsSync(marker),
	true,
	"selected extension tool executes in the SDK worker",
);
inherited.session.dispose();

// Abort settles an in-flight SDK prompt instead of freezing the process.
const slow = fauxProvider({
	provider: "pi-tools-slow",
	models: [{ id: "slow" }],
	tokensPerSecond: 1,
});
runtime.registerNativeProvider(slow.provider);
const slowModel = runtime.getModel("pi-tools-slow", "slow");
assert(slowModel, "registered slow model is available");
slow.setResponses([
	fauxAssistantMessage("this response is deliberately slow enough to abort"),
]);
const abortable = await createAgentSession({
	cwd,
	agentDir: root,
	modelRuntime: runtime,
	model: slowModel,
	noTools: "all",
	settingsManager: settings,
	sessionManager: SessionManager.inMemory(cwd),
});
const pending = abortable.session.prompt("abort me", {
	expandPromptTemplates: false,
});
await new Promise((resolve) => setTimeout(resolve, 25));
await abortable.session.abort();
await pending;
assert.equal(abortable.session.isStreaming, false);
abortable.session.dispose();

console.log(
	JSON.stringify(
		{
			piVersion: "0.85.1",
			durableCreateOpen: true,
			literalTransport: true,
			modelReasoningDiscovery: true,
			controlledInlineExtensions: true,
			inheritedExtensionTools: true,
			recursiveAgentExcluded: true,
			preDispatchToolGate: true,
			abortSettles: true,
			quotaResetMetadata: "not universal; adapter normalization required",
		},
		null,
		2,
	),
);
