export class BodyTooLargeError extends Error {
	readonly maxBytes: number;
	readonly actualBytes: number;

	constructor(maxBytes: number, actualBytes: number) {
		super(
			`Response size (${actualBytes} bytes) exceeds maximum allowed size (${maxBytes} bytes)`,
		);
		this.name = "BodyTooLargeError";
		this.maxBytes = maxBytes;
		this.actualBytes = actualBytes;
	}
}

/**
 * Reads a whole body, failing as soon as it grows past `maxBytes` rather than
 * trusting Content-Length. An abort rejects with the signal's own reason and
 * cancels the stream, so a stalled server cannot hold the read open.
 */
export async function readBodyWithLimit(
	body: ReadableStream<Uint8Array> | null | undefined,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	if (!body) return new Uint8Array();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const onAbort = () => {
		void reader.cancel(signal?.reason).catch(() => undefined);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw new BodyTooLargeError(maxBytes, total);
			chunks.push(value);
		}
	} catch (error) {
		void reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
	if (chunks.length === 1 && chunks[0]) return chunks[0];
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}
