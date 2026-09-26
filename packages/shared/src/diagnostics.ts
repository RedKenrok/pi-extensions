export type Diagnose = (reason: string, detail?: string) => void;

export interface DiagnosticsOptions {
	env?: NodeJS.ProcessEnv;
	write?: (line: string) => void;
}

const MAX_DETAIL_LENGTH = 200;

/**
 * `PI_EXT_DEBUG` is one variable for every extension in this repository: a
 * comma-separated list of package names, or `*` for all of them, so a single
 * setting enables exactly the packages being investigated.
 */
export function diagnosticsEnabled(
	packageName: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (env.PI_EXT_DEBUG ?? "")
		.split(",")
		.map((name) => name.trim())
		.some((name) => name === "*" || name === packageName);
}

/**
 * Returns a sink that writes one `[package] reason` line to stderr per call
 * when diagnostics are enabled, and does nothing otherwise. Callers pass fixed
 * reason codes and at most a short detail: stderr often ends up in bug reports,
 * so tokens, account ids, URLs, and content must never reach it.
 */
export function createDiagnostics(
	packageName: string,
	options: DiagnosticsOptions = {},
): Diagnose {
	if (!diagnosticsEnabled(packageName, options.env)) return () => {};
	const write =
		options.write ??
		((line: string) => {
			process.stderr.write(line);
		});
	return (reason, detail) => {
		// Control characters would let a detail forge extra log lines or
		// terminal escapes.
		const safeDetail = detail
			?.replace(/\p{Cc}+/gu, " ")
			.trim()
			.slice(0, MAX_DETAIL_LENGTH);
		try {
			write(
				`[${packageName}] ${reason}${safeDetail ? `: ${safeDetail}` : ""}\n`,
			);
		} catch {
			// Diagnostics are best-effort and must never change behaviour.
		}
	};
}
