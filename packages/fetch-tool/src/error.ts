import type { AbortCause } from "./request.ts";

export type ErrorType =
	| "aborted"
	| "fetch"
	| "size_limit"
	| "timeout"
	| "unknown"
	| "validation";

export interface ToolErrorDetails {
	errorType: ErrorType | string;
	message: string;
	url?: string | undefined;
	timeout?: number | undefined;
	maxSize?: number | undefined;
	actualSize?: number | undefined;
}

export const toolError = (
	message: string,
	details: Omit<ToolErrorDetails, "message">,
): Error & ToolErrorDetails => Object.assign(new Error(message), details);

/**
 * URLs are echoed into model context and error logs, so any `user:password@`
 * userinfo must not survive. Unparseable input falls back to a textual strip
 * because validation errors echo whatever the caller supplied.
 */
export const redactUrl = (url: string): string => {
	try {
		const parsed = new URL(url);
		if (!parsed.username && !parsed.password) return url;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return url.replace(/\/\/[^/?#@]*@/, "//");
	}
};

export const normalizeError = (
	error: unknown,
	url: string,
	timeout?: number,
	abortCause?: AbortCause,
): ToolErrorDetails => {
	const base = { url: redactUrl(url), timeout };

	if (
		typeof error === "object" &&
		error !== null &&
		"errorType" in error &&
		typeof error.errorType === "string"
	) {
		const typed = error as Partial<ToolErrorDetails>;
		return {
			...base,
			errorType: error.errorType,
			message: typed.message ?? "Unknown error",
			maxSize: typed.maxSize,
			actualSize: typed.actualSize,
		};
	}

	// The abort cause is tracked by the deadline itself, so it is more
	// reliable than inspecting whatever reason object fetch rethrew.
	if (abortCause === "timeout") {
		return {
			...base,
			errorType: "timeout",
			message: timeout
				? `Request timed out after ${timeout}ms`
				: "Request timed out",
		};
	}
	if (abortCause === "caller") {
		return { ...base, errorType: "aborted", message: "Request aborted" };
	}

	if (error instanceof Error) {
		// undici reports DNS, TLS, and connection failures as a generic
		// "fetch failed" with the useful detail on `cause`.
		const cause =
			error.cause instanceof Error && error.cause.message
				? `: ${error.cause.message}`
				: "";
		return { ...base, errorType: "fetch", message: `${error.message}${cause}` };
	}

	return { ...base, errorType: "unknown", message: String(error) };
};
