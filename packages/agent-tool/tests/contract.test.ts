import assert from "node:assert/strict";
import test from "node:test";
import { ContractError, errorResult, validateAction } from "../src/contract.ts";

const model = { provider: "openai-codex", id: "gpt-6-luna" } as const;

test("contract rejects unknown fields and oversized/invalid waits before enqueue", () => {
	assert.throws(
		() => validateAction({ action: "spawn", prompt: "x" }),
		/model/,
	);
	assert.throws(
		() =>
			validateAction({ action: "spawn", prompt: "x", model, surprise: true }),
		ContractError,
	);
	assert.throws(
		() => validateAction({ action: "wait", agentIds: [] }),
		ContractError,
	);
	assert.throws(
		() => validateAction({ action: "idle", agentIds: ["ag_1", "ag_1"] }),
		ContractError,
	);
	assert.throws(
		() => validateAction({ action: "idle", agentIds: ["ag_1"], until: "any" }),
		ContractError,
	);
	assert.throws(
		() => validateAction({ action: "spawn", prompt: "x".repeat(32769), model }),
		ContractError,
	);
});

test("spawn accepts only a positive runtime limit in seconds", () => {
	validateAction({
		action: "spawn",
		prompt: "x",
		model,
		limits: { runtimeSeconds: 3600 },
	});
	for (const limits of [
		{ runtimeMs: 1000 },
		{ turns: 4 },
		{ observedTokens: 1000 },
		{ runtimeSeconds: 1.5 },
		{ runtimeSeconds: 0 },
	])
		assert.throws(
			() => validateAction({ action: "spawn", prompt: "x", model, limits }),
			ContractError,
		);
});

test("idle accepts a bounded unique agent set", () => {
	validateAction({
		action: "idle",
		agentIds: ["ag_1", "ag_2"],
		until: "all_settled",
		requestId: "review",
	});
	validateAction({
		action: "idle",
		agentIds: ["ag_1", "ag_2"],
		until: "quorum",
		quorum: 1,
		activityPolicy: "notify_only",
		disconnectPolicy: "continue_headless",
	});
	validateAction({
		action: "inspect_many",
		agentIds: ["ag_1", "ag_2"],
	});
	validateAction({
		action: "idle_update",
		idleId: "idle_1",
		addAgentIds: ["ag_3"],
	});
	validateAction({ action: "idle_cancel", idleId: "idle_1" });
	assert.throws(
		() =>
			validateAction({
				action: "idle",
				agentIds: ["ag_1"],
				until: "quorum",
				quorum: 2,
			}),
		/quorum/,
	);
	assert.throws(
		() => validateAction({ action: "idle_update", idleId: "idle_1" }),
		/requires/,
	);
});

test("inspect actions reject child-output retrieval fields", () => {
	assert.throws(
		() =>
			validateAction({
				action: "inspect",
				agentId: "ag_1",
				includeOutput: true,
			}),
		ContractError,
	);
	assert.throws(
		() =>
			validateAction({
				action: "inspect_many",
				agentIds: ["ag_1"],
				includeOutput: true,
			}),
		ContractError,
	);
});

test("literal prompt-shaped text is accepted unchanged", () => {
	const text = "/command $" + "{HOME} {{template}}";
	const value = {
		action: "message",
		agentId: "ag_1",
		delivery: "steer",
		text,
	} as const;
	validateAction(value);
	assert.equal(value.text, text);
});

test("unexpected errors cannot leak credentials into tool output", () => {
	const value = errorResult(new Error("Authorization: secret sk-abcdefghijk"));
	assert.equal(value.content[0]?.text.includes("abcdefghijk"), false);
});
