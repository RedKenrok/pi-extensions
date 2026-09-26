import { createDiagnostics } from "pi-extensions-shared/diagnostics";
import pkg from "../package.json" with { type: "json" };

export {
	isRecord,
	nonemptyString,
	stringValue,
} from "pi-extensions-shared/record";

export const PACKAGE_NAME: string = pkg.name;
export const PACKAGE_VERSION: string = pkg.version;

export function formatDuration(ms: number): string {
	const plural = (count: number, unit: string) =>
		`${count} ${unit}${count === 1 ? "" : "s"}`;
	if (ms >= 60_000 && ms % 60_000 === 0) return plural(ms / 60_000, "minute");
	if (ms >= 1_000 && ms % 1_000 === 0) return plural(ms / 1_000, "second");
	return `${ms} ms`;
}

export function isTimeoutReason(reason: unknown): boolean {
	return reason instanceof Error && reason.name === "TimeoutError";
}

/**
 * Opt-in troubleshooting output (see the PI_EXT_DEBUG convention in the
 * shared diagnostics module). Only fixed reason codes are written: never
 * tokens, account ids, or queries, because stderr often ends up in bug
 * reports.
 */
export function diagnose(
	reason: string,
	env: NodeJS.ProcessEnv = process.env,
	write?: (line: string) => void,
): void {
	createDiagnostics(PACKAGE_NAME, { env, ...(write ? { write } : {}) })(reason);
}
