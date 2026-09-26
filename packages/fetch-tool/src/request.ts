export type FetchBody = string | JsonValue;
export type AbortCause = "caller" | "timeout";

type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface Deadline {
	signal: AbortSignal;
	/**
	 * Throws once the caller aborted or the deadline passed. The time check is
	 * needed in addition to the signal because a long synchronous transform
	 * keeps the event loop busy, so the timeout signal cannot fire until it
	 * returns.
	 */
	check(): void;
	cause(): AbortCause | undefined;
}

export const createDeadline = (
	callerSignal: AbortSignal | undefined,
	timeout: number,
	now: () => number = Date.now,
	// Injectable because node:test mock timers cannot drive AbortSignal.timeout.
	timeoutSignal: (ms: number) => AbortSignal = (ms) => AbortSignal.timeout(ms),
): Deadline => {
	const expiresAt = now() + timeout;
	const timerSignal = timeoutSignal(timeout);
	const signal = callerSignal
		? AbortSignal.any([callerSignal, timerSignal])
		: timerSignal;
	let expired = false;
	return {
		signal,
		check() {
			signal.throwIfAborted();
			if (now() >= expiresAt) {
				expired = true;
				throw new DOMException("Request deadline exceeded", "TimeoutError");
			}
		},
		cause() {
			if (callerSignal?.aborted && signal.reason === callerSignal.reason)
				return "caller";
			if (expired || timerSignal.aborted) return "timeout";
			return undefined;
		},
	};
};
