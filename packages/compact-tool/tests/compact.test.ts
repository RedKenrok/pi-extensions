import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactParameters, registerCompactTool } from "../src/compact.ts";

interface CompactOptions {
	customInstructions?: string;
	onComplete: () => void;
	onError: (error: Error) => void;
}

interface ToolOutput {
	content: Array<{ type: string; text: string }>;
	details: { status: string };
	terminate: boolean;
}

interface RegisteredTool {
	name: string;
	executionMode: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: { instructions?: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<ToolOutput>;
}

function setup(
	options: { idle?: boolean; pending?: boolean; hasUI?: boolean } = {},
) {
	let tool: RegisteredTool | undefined;
	let compactOptions: CompactOptions | undefined;
	const sent: string[] = [];
	const notifications: Array<[string, string]> = [];
	const pi = {
		registerTool(value: unknown) {
			tool = value as RegisteredTool;
		},
		sendUserMessage(message: string) {
			sent.push(message);
		},
	} as unknown as ExtensionAPI;
	registerCompactTool(pi);
	const ctx = {
		hasUI: options.hasUI ?? true,
		ui: {
			notify: (message: string, level: string) =>
				notifications.push([message, level]),
		},
		compact(value: CompactOptions) {
			compactOptions = value;
		},
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => options.pending ?? false,
	};
	assert.ok(tool);
	return {
		tool,
		ctx,
		sent,
		notifications,
		getCompactOptions: () => compactOptions,
	};
}

const flushMicrotasks = () =>
	new Promise<void>((resolve) => queueMicrotask(resolve));

describe("compact tool", () => {
	it("registers the expected schema and sequential tool without lifecycle or context hooks", () => {
		const events: string[] = [];
		let registered: unknown;
		const pi = {
			registerTool(tool: unknown) {
				registered = tool;
			},
			on(name: string) {
				events.push(name);
			},
		} as unknown as ExtensionAPI;
		registerCompactTool(pi);
		const tool = registered as {
			name: string;
			executionMode: string;
			parameters: unknown;
		};
		assert.equal(tool.name, "compact");
		assert.equal(tool.executionMode, "sequential");
		assert.equal(tool.parameters, compactParameters);
		assert.deepEqual(events, []);
		assert.deepEqual(Object.keys(compactParameters.properties), [
			"instructions",
		]);
	});

	it("returns immediately with queued wording, termination, and forwards optional instructions", async () => {
		const state = setup();
		let completed = false;
		const execution = state.tool.execute(
			"call",
			{ instructions: "focus here" },
			undefined,
			undefined,
			state.ctx,
		);
		const output = await execution;
		assert.deepEqual(output.details, { status: "queued" });
		assert.equal(output.terminate, true);
		assert.match(output.content[0]?.text ?? "", /queued/);
		assert.match(output.content[0]?.text ?? "", /not confirmation/);
		const options = state.getCompactOptions();
		assert.ok(options);
		assert.equal(options.customInstructions, "focus here");
		options.onComplete = () => {
			completed = true;
		};
		assert.equal(completed, false);
	});

	it("omits native instructions when absent", async () => {
		const state = setup();
		await state.tool.execute("call", {}, undefined, undefined, state.ctx);
		assert.equal(state.getCompactOptions()?.customInstructions, undefined);
	});

	it("continues once, only after successful completion while idle with no pending messages", async () => {
		const state = setup();
		await state.tool.execute("call", {}, undefined, undefined, state.ctx);
		const options = state.getCompactOptions();
		assert.ok(options);
		options.onComplete();
		options.onComplete();
		assert.deepEqual(state.sent, []);
		await flushMicrotasks();
		assert.equal(state.sent.length, 1);
		assert.match(state.sent[0] ?? "", /Do not call compact again/);
	});

	it("does not continue when busy or when user messages are pending", async () => {
		for (const config of [{ idle: false }, { pending: true }]) {
			const state = setup(config);
			await state.tool.execute("call", {}, undefined, undefined, state.ctx);
			state.getCompactOptions()?.onComplete();
			await flushMicrotasks();
			assert.deepEqual(state.sent, []);
		}
	});

	it("notifies UI on failure, is headless-safe, and never resumes", async () => {
		for (const hasUI of [true, false]) {
			const state = setup({ hasUI });
			await state.tool.execute("call", {}, undefined, undefined, state.ctx);
			state.getCompactOptions()?.onError(new Error("boom"));
			state.getCompactOptions()?.onComplete();
			await flushMicrotasks();
			assert.deepEqual(state.sent, []);
			assert.equal(state.notifications.length, hasUI ? 1 : 0);
		}
	});

	it("honors pre-aborted execution without scheduling compaction or synthetic continuation", async () => {
		const state = setup();
		const controller = new AbortController();
		controller.abort();
		const output = await state.tool.execute(
			"call",
			{},
			controller.signal,
			undefined,
			state.ctx,
		);
		assert.deepEqual(output.details, { status: "cancelled" });
		assert.equal(output.terminate, true);
		assert.equal(state.getCompactOptions(), undefined);
		await flushMicrotasks();
		assert.deepEqual(state.sent, []);
	});
});
