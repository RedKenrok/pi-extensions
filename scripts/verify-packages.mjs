import { spawn } from "node:child_process";
import {
	glob,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	symlink,
} from "node:fs/promises";
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

// Asynchronous so packages can be packed and installed concurrently; npm
// installs dominate the verifier's runtime and are independent per package.
const run = (command, args, options = {}) =>
	new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			...options,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) => {
			if (status === 0) resolvePromise(stdout);
			else
				reject(
					new Error(
						`${command} ${args.join(" ")} failed (exit ${status ?? "unknown"}):\n${stderr || stdout}`,
					),
				);
		});
	});

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

// Runtime sources are every TypeScript file outside tests and dependencies.
// A `files` entry that silently drops one would otherwise surface only when
// Pi happens to import that module.
async function runtimeSources(packagePath) {
	const sources = [];
	for await (const entry of glob("**/*.ts", {
		cwd: packagePath,
		exclude: (name) =>
			name === "node_modules" || name === "tests" || name === "coverage",
	})) {
		const path = entry.replaceAll("\\", "/");
		if (!/\.(test|spec)\.ts$/.test(path)) sources.push(path);
	}
	return sources;
}

const SHARED_NAME = "shared";
const sharedRoot = join(root, "packages/shared");
const BUNDLED_PREFIX = `node_modules/${SHARED_NAME}/`;

// The shared package publishes only its manifest and src/, so that is exactly
// what every consumer's archive must carry under node_modules.
async function sharedFiles() {
	const files = ["package.json"];
	for await (const entry of glob("src/**/*.ts", { cwd: sharedRoot }))
		files.push(entry.replaceAll("\\", "/"));
	return files.sort();
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

async function verifyPackage(packagePath, scratch) {
	const manifest = await readJson(join(packagePath, "package.json"));
	if (manifest.private !== true)
		throw new Error(`${manifest.name} must remain private`);
	// The shared runtime library is not a Pi extension; it is verified through
	// the archives of the extensions that bundle it.
	if (manifest.name === SHARED_NAME) {
		if (manifest.pi !== undefined)
			throw new Error(`${SHARED_NAME} must not declare Pi extensions`);
		return;
	}
	const entrypoints = manifest.pi?.extensions;
	if (
		!Array.isArray(entrypoints) ||
		entrypoints.some((entry) => typeof entry !== "string")
	) {
		throw new Error(
			`${manifest.name}: pi.extensions must be an array of strings`,
		);
	}

	// Reproduce user extension discovery through a symlink outside the checkout.
	// Pi's jiti resolves imports relative to the symlink path, not the real path.
	const symlinkAgent = join(scratch, `${manifest.name}-agent`);
	const symlinkPath = join(symlinkAgent, "extensions", manifest.name);
	await mkdir(join(symlinkAgent, "extensions"), { recursive: true });
	await symlink(packagePath, symlinkPath, "dir");
	const { DefaultResourceLoader: LocalLoader } = await import(
		pathToFileURL(
			join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
		).href
	);
	const localLoader = new LocalLoader({
		cwd: scratch,
		agentDir: symlinkAgent,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await localLoader.reload();
	const localResult = localLoader.getExtensions();
	if (localResult.errors.length > 0)
		throw new Error(
			`${manifest.name}: symlinked extension failed to load: ${localResult.errors.map(({ error }) => formatError(error)).join("\n")}`,
		);
	for (const entry of entrypoints) {
		if (
			!localResult.extensions.some(
				({ resolvedPath }) => resolvedPath === resolve(symlinkPath, entry),
			)
		)
			throw new Error(
				`${manifest.name}: symlinked extension ${entry} not loaded`,
			);
	}

	const dryRun = JSON.parse(
		await run("npm", ["pack", "--dry-run", "--json"], { cwd: packagePath }),
	)[0];
	const names = new Set(dryRun.files.map(({ path }) => path));
	for (const entry of entrypoints) {
		if (!names.has(entry.replace(/^\.\//, ""))) {
			throw new Error(
				`${manifest.name}: extension entry ${entry} is missing from npm pack`,
			);
		}
	}
	for (const source of await runtimeSources(packagePath)) {
		if (!names.has(source)) {
			throw new Error(
				`${manifest.name}: runtime source ${source} is missing from npm pack`,
			);
		}
	}
	const bundlesShared = SHARED_NAME in (manifest.dependencies ?? {});
	if (bundlesShared) {
		if (!manifest.bundleDependencies?.includes(SHARED_NAME))
			throw new Error(
				`${manifest.name}: depends on ${SHARED_NAME} but does not bundle it`,
			);
		for (const file of await sharedFiles()) {
			if (!names.has(`${BUNDLED_PREFIX}${file}`))
				throw new Error(
					`${manifest.name}: bundled ${SHARED_NAME} is missing ${file}`,
				);
		}
	}
	for (const name of names) {
		// Only the bundled shared package may appear under node_modules, and the
		// same test-file rules apply inside it.
		const path =
			bundlesShared && name.startsWith(BUNDLED_PREFIX)
				? name.slice(BUNDLED_PREFIX.length)
				: name;
		if (
			/(^|\/)(tests?|test-support|coverage|node_modules)(\/|$)|\.(test|spec)\.[cm]?[jt]s$|(^|\/)\.env(?:\.|$)/i.test(
				path,
			)
		) {
			throw new Error(
				`${manifest.name}: unexpected private/test file in package: ${name}`,
			);
		}
	}

	const consumer = join(
		scratch,
		`${manifest.name.replaceAll("/", "-")}-consumer`,
	);
	const packDir = join(consumer, "pack");
	await mkdir(packDir, { recursive: true });
	const packed = JSON.parse(
		await run("npm", ["pack", "--pack-destination", packDir, "--json"], {
			cwd: packagePath,
		}),
	)[0];
	await run("npm", ["init", "-y"], { cwd: consumer });
	const peers = Object.keys(manifest.peerDependencies ?? {})
		.filter((name) => name.startsWith("@earendil-works/"))
		.map((name) => `${name}@${piVersion}`);
	await run(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			join(packDir, packed.filename),
			...peers,
		],
		{ cwd: consumer },
	);

	const installedRoot = join(consumer, "node_modules", manifest.name);
	const installedManifest = await readJson(join(installedRoot, "package.json"));
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
	const installedPeers = Object.keys(installedManifest.peerDependencies ?? {});
	if (installedPeers.length > 0) {
		// Resolve from the consumer directory, as a real install would, in one
		// process rather than one spawn per peer.
		await run(
			"node",
			[
				"--input-type=module",
				"-e",
				`for (const peer of ${JSON.stringify(installedPeers)}) import.meta.resolve(peer);`,
			],
			{ cwd: consumer },
		);
	}
}

const scratch = await mkdtemp(join(tmpdir(), "pi-extension-packages-"));
try {
	const results = await Promise.allSettled(
		packageDirs.map((packagePath) => verifyPackage(packagePath, scratch)),
	);
	const failures = results
		.filter((result) => result.status === "rejected")
		.map((result) => formatError(result.reason));
	// postpack must restore a live link rather than leave a stale copy.
	for (const packagePath of packageDirs) {
		const manifest = await readJson(join(packagePath, "package.json"));
		if (!(SHARED_NAME in (manifest.dependencies ?? {}))) continue;
		const path = join(packagePath, "node_modules", SHARED_NAME);
		try {
			const stat = await lstat(path);
			if (
				!stat.isSymbolicLink() ||
				resolve(packagePath, "node_modules", await readlink(path)) !==
					sharedRoot
			)
				failures.push(
					`${packagePath}: ${SHARED_NAME} is not linked to live shared sources`,
				);
		} catch (error) {
			if (error.code === "ENOENT")
				failures.push(
					`${packagePath}: missing ${SHARED_NAME} development link`,
				);
			else throw error;
		}
	}
	if (failures.length > 0) throw new Error(failures.join("\n\n"));
	console.log(
		`Verified ${packageDirs.length} workspace packages: archives, bundled ${SHARED_NAME}, exact Pi ${piVersion} peers, and loaded extension entrypoints.`,
	);
} finally {
	await rm(scratch, { recursive: true, force: true });
}
