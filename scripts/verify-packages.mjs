import { spawnSync } from "node:child_process";
import { glob, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const rootManifest = JSON.parse(
	await readFile(join(root, "package.json"), "utf8"),
);
const workspacePatterns = Array.isArray(rootManifest.workspaces)
	? rootManifest.workspaces
	: rootManifest.workspaces?.packages;
if (
	!Array.isArray(workspacePatterns) ||
	workspacePatterns.some((pattern) => typeof pattern !== "string")
) {
	throw new Error("Root workspaces must be an array of glob pattern strings");
}

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed (exit ${result.status ?? "unknown"}):\n${result.stderr || result.stdout}`,
		);
	}
	return result.stdout;
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const formatError = (error) =>
	error instanceof Error ? (error.stack ?? error.message) : String(error);

async function discoverWorkspaceDirs() {
	const paths = new Set();
	for (const pattern of workspacePatterns) {
		for await (const entry of glob(pattern, {
			cwd: root,
			withFileTypes: true,
		})) {
			if (entry.isDirectory()) {
				paths.add(resolve(entry.parentPath, entry.name));
			}
		}
	}
	const dirs = [];
	for (const path of paths) {
		try {
			await readFile(join(path, "package.json"));
			dirs.push(path);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	return dirs.sort();
}

const packageDirs = await discoverWorkspaceDirs();
if (packageDirs.length === 0)
	throw new Error("No package directories were found from root workspaces");

const installedPiVersion = (
	await readJson(
		join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"),
	)
).version;
const piVersion = process.env.PI_VERSION || installedPiVersion;
if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(piVersion)) {
	throw new Error(`PI_VERSION must be an exact Pi version, got: ${piVersion}`);
}

const scratch = await mkdtemp(join(tmpdir(), "pi-extension-packages-"));
try {
	for (const packagePath of packageDirs) {
		const manifest = await readJson(join(packagePath, "package.json"));
		if (manifest.private !== true)
			throw new Error(`${manifest.name} must remain private`);
		const entrypoints = manifest.pi?.extensions;
		if (
			!Array.isArray(entrypoints) ||
			entrypoints.some((entry) => typeof entry !== "string")
		) {
			throw new Error(
				`${manifest.name}: pi.extensions must be an array of strings`,
			);
		}

		const dryRun = JSON.parse(
			run("npm", ["pack", "--dry-run", "--json"], { cwd: packagePath }),
		)[0];
		const names = new Set(dryRun.files.map(({ path }) => path));
		for (const entry of entrypoints) {
			if (!names.has(entry.replace(/^\.\//, ""))) {
				throw new Error(
					`${manifest.name}: extension entry ${entry} is missing from npm pack`,
				);
			}
		}
		for (const name of names) {
			if (
				/(^|\/)(tests?|coverage|node_modules)(\/|$)|\.(test|spec)\.[cm]?[jt]s$|(^|\/)\.env(?:\.|$)/i.test(
					name,
				)
			) {
				throw new Error(
					`${manifest.name}: unexpected private/test file in package: ${name}`,
				);
			}
		}

		const packed = JSON.parse(
			run("npm", ["pack", "--pack-destination", scratch, "--json"], {
				cwd: packagePath,
			}),
		)[0];
		const consumer = join(
			scratch,
			`${manifest.name.replaceAll("/", "-")}-consumer`,
		);
		await mkdir(consumer);
		run("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
		const peers = Object.keys(manifest.peerDependencies ?? {})
			.filter((name) => name.startsWith("@earendil-works/"))
			.map((name) => `${name}@${piVersion}`);
		run(
			"npm",
			[
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				join(scratch, packed.filename),
				...peers,
			],
			{ cwd: consumer },
		);

		const installedRoot = join(consumer, "node_modules", manifest.name);
		const installedManifest = await readJson(
			join(installedRoot, "package.json"),
		);
		const installedEntrypoints = installedManifest.pi?.extensions;
		if (
			!Array.isArray(installedEntrypoints) ||
			installedEntrypoints.some((entry) => typeof entry !== "string") ||
			installedEntrypoints.length !== entrypoints.length ||
			installedEntrypoints.some((entry, index) => entry !== entrypoints[index])
		) {
			throw new Error(
				`${manifest.name}: packed pi.extensions does not match the source manifest`,
			);
		}
		for (const entry of installedEntrypoints) {
			if (!names.has(entry.replace(/^\.\//, ""))) {
				throw new Error(
					`${manifest.name}: unresolved advertised extension ${entry}`,
				);
			}
		}
		try {
			const { DefaultResourceLoader } = await import(
				pathToFileURL(
					join(
						consumer,
						"node_modules/@earendil-works/pi-coding-agent/dist/index.js",
					),
				).href
			);
			const loader = new DefaultResourceLoader({
				cwd: consumer,
				agentDir: join(consumer, "agent"),
				// Pass the installed package root so Pi consumes its pi manifest,
				// rather than bypassing package discovery with individual files.
				additionalExtensionPaths: [installedRoot],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			const result = loader.getExtensions();
			if (result.errors.length > 0) {
				throw new Error(
					result.errors
						.map(({ path, error }) => `${path}: ${formatError(error)}`)
						.join("\n"),
				);
			}
			const loadedPaths = new Set(
				result.extensions.map(({ resolvedPath }) => resolvedPath),
			);
			for (const entry of installedEntrypoints) {
				if (!loadedPaths.has(resolve(installedRoot, entry))) {
					throw new Error(
						`loader did not register advertised extension ${entry}`,
					);
				}
			}
		} catch (error) {
			throw new Error(
				`${manifest.name}: failed to load advertised extensions with Pi ${piVersion}: ${formatError(error)}`,
				{ cause: error },
			);
		}
		for (const peer of Object.keys(installedManifest.peerDependencies ?? {})) {
			run("node", ["-e", `import.meta.resolve(${JSON.stringify(peer)})`], {
				cwd: consumer,
			});
		}
	}
	console.log(
		`Verified ${packageDirs.length} workspace packages: archives, exact Pi ${piVersion} peers, and loaded extension entrypoints.`,
	);
} finally {
	await rm(scratch, { recursive: true, force: true });
}
