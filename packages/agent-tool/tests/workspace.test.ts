import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareWorkspace } from "../src/workspace.ts";

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-tools-workspace-source-"));
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "config", "user.name", "Pi Tools Test"]);
	execFileSync("git", [
		"-C",
		root,
		"config",
		"user.email",
		"pi-tools@example.invalid",
	]);
	writeFileSync(join(root, "tracked.txt"), "first\n");
	execFileSync("git", ["-C", root, "add", "tracked.txt"]);
	execFileSync("git", ["-C", root, "commit", "-q", "-m", "initial"]);
	return root;
}

test("worktree preparation persists and reconciles exact source revision", async () => {
	const root = repository();
	const target = join(
		mkdtempSync(join(tmpdir(), "pi-tools-workspace-target-")),
		"child",
	);
	const expected = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	const created = await prepareWorkspace(root, "worktree", target, target);
	assert.equal(created.path, target);
	assert.equal(created.sourceRoot, realpathSync(root));
	assert.equal(created.baseRevision, expected);
	assert.deepEqual(
		await prepareWorkspace(root, "worktree", target, target),
		created,
	);

	writeFileSync(join(root, "tracked.txt"), "second\n");
	execFileSync("git", ["-C", root, "add", "tracked.txt"]);
	execFileSync("git", ["-C", root, "commit", "-q", "-m", "next"]);
	await assert.rejects(
		() => prepareWorkspace(root, "worktree", target, target),
		/does not match the requested repository and base revision/,
	);
});

test("shared workspace must already be a directory", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tools-shared-"));
	await assert.rejects(
		() => prepareWorkspace(root, "shared", "missing", "unused"),
		/Shared workspace directory does not exist/,
	);
});
