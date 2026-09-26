// Runs a package's tests from its own directory (npm sets cwd to the package).
//
// Every package runs `node --test` the same way; only the coverage scope and
// thresholds differ, and those live as data under "testCoverage" in the
// package's package.json. Keeping the flags here means a runner change is made
// once rather than copied into every manifest.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const TEST_FILES = "tests/*.test.ts";
const manifest = JSON.parse(
	await readFile(join(process.cwd(), "package.json"), "utf8"),
);
const args = ["--test"];

if (process.argv.includes("--coverage")) {
	const coverage = manifest.testCoverage;
	if (
		!coverage ||
		!Array.isArray(coverage.include) ||
		coverage.include.length === 0
	) {
		throw new Error(
			`${manifest.name}: package.json needs testCoverage.include for coverage runs`,
		);
	}
	args.push("--experimental-test-coverage");
	for (const pattern of coverage.include)
		args.push(`--test-coverage-include=${pattern}`);
	for (const metric of ["lines", "branches", "functions"]) {
		const threshold = coverage[metric];
		if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100)
			throw new Error(
				`${manifest.name}: testCoverage.${metric} must be an integer percentage`,
			);
		args.push(`--test-coverage-${metric}=${threshold}`);
	}
}

// node expands the glob itself, so the pattern is passed through unexpanded
// and behaves the same on every shell.
args.push(TEST_FILES);

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("error", (error) => {
	console.error(error);
	process.exit(1);
});
child.on("close", (code, signal) => {
	process.exit(code ?? (signal ? 1 : 0));
});
