// Runs as a consumer package's prepack/postpack script (cwd is that package).
//
// npm workspaces hoist `pi-extensions-shared` to a symlink in the repository
// root, and `npm pack` does not follow hoisted symlinks when it collects
// bundleDependencies. Copying the shared package into the consumer's own
// node_modules just for the duration of the pack makes the tarball
// self-contained, which a Pi install from an archive needs. Local development
// keeps resolving through the root symlink, so the copy is removed afterwards
// to avoid shadowing live sources with a stale snapshot.
import { cp, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const SHARED_NAME = "pi-extensions-shared";
const sharedRoot = resolve(import.meta.dirname, "../packages/shared");
const consumerModules = join(process.cwd(), "node_modules");
const target = join(consumerModules, SHARED_NAME);

await rm(target, { recursive: true, force: true });

if (process.argv.includes("--clean")) {
	// Leave no empty node_modules behind in a package that has no other
	// package-local dependencies.
	try {
		if ((await readdir(consumerModules)).length === 0)
			await rmdir(consumerModules);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
} else {
	await mkdir(target, { recursive: true });
	// Only what the shared manifest publishes: its manifest and sources.
	await cp(join(sharedRoot, "package.json"), join(target, "package.json"));
	await cp(join(sharedRoot, "src"), join(target, "src"), { recursive: true });
}
