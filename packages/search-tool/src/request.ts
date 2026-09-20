export type FetchBody = string | JsonValue;
export type AbortCause = "caller" | "timeout";

type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export const createTimeoutSignal = (
	signal: AbortSignal | undefined,
	timeout?: number,
): {
	signal: AbortSignal | undefined;
	cleanup: () => void;
	getAbortCause: () => AbortCause | undefined;
} => {
	if (!timeout && !signal) {
		return {
			signal: undefined,
			cleanup: () => {},
			getAbortCause: () => undefined,
		};
	}

	const controller = new AbortController();
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let abortCause: AbortCause | undefined;

	const abortHandler = () => {
		if (!controller.signal.aborted) {
			abortCause = "caller";
			controller.abort(signal?.reason);
		}
	};

	if (signal?.aborted) {
		abortHandler();
	} else if (signal) {
		signal.addEventListener("abort", abortHandler);
	}

	if (timeout) {
		timeoutId = setTimeout(() => {
			if (!controller.signal.aborted) {
				abortCause = "timeout";
				controller.abort(new DOMException("Request timed out", "AbortError"));
			}
		}, timeout);
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}

			if (signal) {
				signal.removeEventListener("abort", abortHandler);
			}
		},
		getAbortCause: () => abortCause,
	};
};
