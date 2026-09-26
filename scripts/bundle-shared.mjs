// Runs as a consumer package's prepack/postpack script (cwd is that package).
//
// npm workspaces hoist `shared` to a symlink in the repository
// root, and `npm pack` does not follow hoisted symlinks when it collects
// bundleDependencies. Copying the shared package into the consumer's own
// node_modules just for the duration of the pack makes the tarball
// self-contained. After packing, restore a package-local symlink: Pi's jiti
// loader resolves symlinked extension paths from ~/.pi/agent/extensions, not
// from the real workspace path, so the hoisted root dependency is invisible.
import { cp, glob, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const SHARED_NAME = "shared";
const sharedRoot = resolve(import.meta.dirname, "../packages/shared");
async function linkShared(consumerRoot) {
	const consumerModules = join(consumerRoot, "node_modules");
	const target = join(consumerModules, SHARED_NAME);
	await mkdir(consumerModules, { recursive: true });
	await rm(target, { recursive: true, force: true });
	await symlink(relative(consumerModules, sharedRoot), target, "dir");
}

if (process.argv.includes("--link-all")) {
	for await (const manifestPath of glob("packages/*/package.json", {
		cwd: resolve(import.meta.dirname, ".."),
	})) {
		const root = resolve(import.meta.dirname, "..", manifestPath, "..");
		const manifest = JSON.parse(
			await readFile(join(root, "package.json"), "utf8"),
		);
		if (SHARED_NAME in (manifest.dependencies ?? {})) await linkShared(root);
	}
} else if (process.argv.includes("--clean")) {
	await linkShared(process.cwd());
} else {
	const target = join(process.cwd(), "node_modules", SHARED_NAME);
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	// Only what the shared manifest publishes: its manifest and sources.
	await cp(join(sharedRoot, "package.json"), join(target, "package.json"));
	await cp(join(sharedRoot, "src"), join(target, "src"), { recursive: true });
}
