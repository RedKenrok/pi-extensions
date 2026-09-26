import assert from "node:assert/strict";
import test from "node:test";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { partialFake } from "../../../test-support/fakes.ts";
import {
	checkpointFromEntry,
	latestCompaction,
	planRemoteCompaction,
} from "../src/branch.ts";
import { buildCheckpoint } from "../src/remote.ts";
import { model } from "./fakes.ts";

const user = { role: "user" as const, content: "discarded", timestamp: 1 };
const checkpoint = buildCheckpoint(model.id, "hash", {
	type: "compaction",
	encrypted_content: "opaque",
});
const remoteEntry = {
	type: "compaction",
	id: "c1",
	firstKeptEntryId: "c1",
	summary: "s",
	details: { remoteCompaction: checkpoint },
};

function plan(
	overrides: {
		branch?: unknown[];
		customInstructions?: string;
		previousSummary?: string;
		messages?: (typeof user)[];
		model?: Parameters<typeof planRemoteCompaction>[1];
	} = {},
) {
	const branch = overrides.branch ?? [];
	const event = partialFake<
		Pick<
			SessionBeforeCompactEvent,
			"branchEntries" | "customInstructions" | "preparation"
		>
	>({
		branchEntries: branch as SessionBeforeCompactEvent["branchEntries"],
		...(overrides.customInstructions !== undefined
			? { customInstructions: overrides.customInstructions }
			: {}),
		preparation: {
			messagesToSummarize: overrides.messages ?? [user],
			turnPrefixMessages: [],
			isSplitTurn: false,
			...(overrides.previousSummary !== undefined
				? { previousSummary: overrides.previousSummary }
				: {}),
		},
	});
	const latest = latestCompaction(branch);
	const result = planRemoteCompaction(
		event,
		"model" in overrides ? overrides.model : model,
		latest,
		checkpointFromEntry(latest),
	);
	return result.ok ? "ok" : result.reason;
}

test("each ineligible compaction reports a specific reason", () => {
	assert.equal(plan(), "ok");
	assert.equal(plan({ customInstructions: "focus" }), "custom_instructions");
	assert.equal(plan({ model: undefined }), "no_model");
	assert.equal(
		plan({ model: { ...model, baseUrl: "https://evil.example/backend-api" } }),
		"untrusted_model",
	);
	assert.equal(
		plan({ branch: [{ type: "compaction", id: "n", details: {} }] }),
		"invalid_checkpoint",
	);
	assert.equal(plan({ previousSummary: "old" }), "summary_without_checkpoint");
	assert.equal(
		plan({
			branch: [
				remoteEntry,
				{
					type: "message",
					message: {
						role: "assistant",
						provider: model.provider,
						api: model.api,
						model: "other",
					},
				},
			],
		}),
		"tail_incompatible",
	);
	assert.equal(plan({ messages: [] }), "nothing_to_discard");
	assert.equal(plan({ branch: [remoteEntry], previousSummary: "s" }), "ok");
});

test("only the latest compaction entry is considered", () => {
	const native = { type: "compaction", id: "n", details: { readFiles: [] } };
	assert.equal(latestCompaction([remoteEntry, native])?.entry, native);
	assert.equal(latestCompaction([{ type: "message" }]), undefined);
	assert.deepEqual(checkpointFromEntry(undefined), { state: "none" });
	assert.equal(
		checkpointFromEntry(latestCompaction([remoteEntry])).state,
		"valid",
	);
});
