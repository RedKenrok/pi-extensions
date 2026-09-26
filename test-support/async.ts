export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

// Lets a test hold an operation open at a precise point and settle it later,
// which is how races between cancellation and completion are reproduced.
export function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

// setImmediate runs after every pending promise callback, so awaiting it
// drains microtasks without depending on wall-clock time.
export function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

// Captured at import time so the helper still holds a real timer while a test
// has node:test mock timers enabled.
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

// AbortSignal.timeout() uses an unreferenced timer, so on some Node releases
// the test runner sees an empty event loop and cancels a test that is only
// waiting on that signal. Holding a referenced timer for the duration keeps
// the wait observable without changing the production signal.
export async function holdingEventLoop<T>(work: () => Promise<T>): Promise<T> {
	const handle = realSetInterval(() => {}, 1_000);
	try {
		return await work();
	} finally {
		realClearInterval(handle);
	}
}
