import type { AbortCause } from "./request.ts";

interface ToolErrorDetails {
	errorType: string;
	message: string;
	url?: string | undefined;
	timeout?: number | undefined;
	status?: number | undefined;
	statusText?: string | undefined;
	maxSize?: number | undefined;
	actualSize?: number | undefined;
}

export const normalizeError = (
	error: unknown,
	url: string,
	timeout?: number,
	abortCause?: AbortCause,
): ToolErrorDetails => {
	if (
		typeof error === "object" &&
		error !== null &&
		"errorType" in error &&
		typeof (error as { errorType?: unknown }).errorType === "string"
	) {
		const typedError = error as {
			errorType: string;
			message?: string;
			maxSize?: number;
			actualSize?: number;
		};

		return {
			errorType: typedError.errorType,
			message: typedError.message ?? "Unknown error",
			url,
			timeout,
			maxSize: typedError.maxSize,
			actualSize: typedError.actualSize,
		};
	}

	if (abortCause) {
		return {
			errorType: abortCause === "timeout" ? "timeout" : "aborted",
			message:
				abortCause === "timeout" && timeout
					? `Request timed out after ${timeout}ms`
					: "Request aborted",
			url,
			timeout,
		};
	}

	if (error instanceof Error) {
		if (error.name === "AbortError") {
			return {
				errorType: abortCause === "timeout" ? "timeout" : "aborted",
				message:
					abortCause === "timeout" && timeout
						? `Request timed out after ${timeout}ms`
						: "Request aborted",
				url,
				timeout,
			};
		}

		return {
			errorType: "fetch",
			message: error.message,
			url,
			timeout,
		};
	}

	return {
		errorType: "unknown",
		message: String(error),
		url,
		timeout,
	};
};
