import { SseLimitError, sseFrames } from "shared/sse";

export const MAX_STREAM_BYTES = 8 * 1024 * 1024;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Raw SSE frames from the remote-compaction stream, with limit failures
 * phrased for this extension. Aborts reject with the signal's own reason.
 */
export async function* compactionFrames(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): AsyncGenerator<string> {
	try {
		yield* sseFrames(body, {
			signal,
			maxStreamBytes: MAX_STREAM_BYTES,
			maxFrameBytes: MAX_FRAME_BYTES,
		});
	} catch (error) {
		if (!(error instanceof SseLimitError)) throw error;
		throw new Error(
			error.kind === "stream"
				? "Remote compaction stream exceeded its size limit"
				: "Remote compaction SSE frame exceeded its size limit",
		);
	}
}
