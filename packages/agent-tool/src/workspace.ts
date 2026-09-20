import { execFile } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { ContractError } from "./contract.ts";

const execFileAsync = promisify(execFile);

export interface PreparedWorkspace {
	path: string;
	sourceRoot?: string;
	baseRevision?: string;
}

export async function verifyWorktreeProvenance(
	workspace: PreparedWorkspace,
): Promise<void> {
	if (!workspace.sourceRoot || !workspace.baseRevision) {
		throw new ContractError(
			"workspace_conflict",
			"Persisted worktree provenance is incomplete",
		);
	}
	try {
		const targetRevision = (
			await execFileAsync("git", ["-C", workspace.path, "rev-parse", "HEAD"])
		).stdout.trim();
		const sourceCommon = resolve(
			workspace.sourceRoot,
			(
				await execFileAsync("git", [
					"-C",
					workspace.sourceRoot,
					"rev-parse",
					"--git-common-dir",
				])
			).stdout.trim(),
		);
		const targetCommon = resolve(
			workspace.path,
			(
				await execFileAsync("git", [
					"-C",
					workspace.path,
					"rev-parse",
					"--git-common-dir",
				])
			).stdout.trim(),
		);
		if (
			targetRevision !== workspace.baseRevision ||
			targetCommon !== sourceCommon
		)
			throw new Error("provenance mismatch");
	} catch {
		throw new ContractError(
			"workspace_conflict",
			`Existing worktree path ${workspace.path} does not match the persisted repository and base revision`,
		);
	}
}

export async function prepareWorkspace(
	cwd: string,
	mode: "shared" | "worktree",
	requestedPath: string | undefined,
	defaultPath: string,
): Promise<PreparedWorkspace> {
	const canonical = resolve(cwd);
	if (mode === "shared") {
		const path = requestedPath ? resolve(canonical, requestedPath) : canonical;
		try {
			if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new ContractError(
				"missing_workspace",
				`Shared workspace directory does not exist: ${path}`,
			);
		}
		return { path };
	}
	let root: string;
	let revision: string;
	try {
		root = (
			await execFileAsync("git", [
				"-C",
				canonical,
				"rev-parse",
				"--show-toplevel",
			])
		).stdout.trim();
		revision = (
			await execFileAsync("git", ["-C", canonical, "rev-parse", "HEAD"])
		).stdout.trim();
	} catch {
		throw new ContractError(
			"workspace_required",
			"worktree mode requires a Git repository with a resolvable HEAD",
		);
	}
	const target = resolve(requestedPath ?? defaultPath);
	await mkdir(dirname(target), { recursive: true });
	try {
		await access(target);
		const targetRevision = (
			await execFileAsync("git", ["-C", target, "rev-parse", "HEAD"])
		).stdout.trim();
		const sourceCommon = resolve(
			root,
			(
				await execFileAsync("git", [
					"-C",
					root,
					"rev-parse",
					"--git-common-dir",
				])
			).stdout.trim(),
		);
		const targetCommon = resolve(
			target,
			(
				await execFileAsync("git", [
					"-C",
					target,
					"rev-parse",
					"--git-common-dir",
				])
			).stdout.trim(),
		);
		if (targetRevision === revision && targetCommon === sourceCommon)
			return { path: target, sourceRoot: root, baseRevision: revision };
		throw new ContractError(
			"workspace_conflict",
			`Existing worktree path ${target} does not match the requested repository and base revision`,
		);
	} catch (error) {
		if (error instanceof ContractError) throw error;
	}
	try {
		await execFileAsync("git", [
			"-C",
			root,
			"worktree",
			"add",
			"--detach",
			target,
			revision,
		]);
	} catch (error) {
		throw new ContractError(
			"workspace_create_failed",
			`Could not create worktree: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { path: target, sourceRoot: root, baseRevision: revision };
}

export async function workspaceExists(path: string): Promise<boolean> {
	try {
		await import("node:fs/promises").then(({ access }) => access(path));
		return true;
	} catch {
		return false;
	}
}
