export class SseLimitError extends Error {
	readonly kind: "stream" | "frame";

	constructor(kind: "stream" | "frame") {
		super(
			kind === "stream"
				? "SSE stream exceeded its size limit"
				: "SSE frame exceeded its size limit",
		);
		this.name = "SseLimitError";
		this.kind = kind;
	}
}

export interface SseFrameOptions {
	signal?: AbortSignal;
	maxStreamBytes: number;
	maxFrameBytes: number;
}

/**
 * Yields raw SSE frames (the text between blank lines) from a byte stream.
 *
 * Decoded text is kept as a list of pieces and only joined once a separator
 * arrives, and byte counts come from the incoming chunks. Scanning a growing
 * concatenated string would force the engine to flatten it on every chunk,
 * which makes a large frame delivered in small chunks quadratic.
 *
 * An abort rejects with the signal's reason. Size limits reject with
 * SseLimitError so each caller can phrase the failure for its own users.
 */
export async function* sseFrames(
	body: ReadableStream<Uint8Array>,
	options: SseFrameOptions,
): AsyncGenerator<string> {
	const { signal, maxStreamBytes, maxFrameBytes } = options;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const hasSeparator = /\r?\n\r?\n/;
	const separator = /\r?\n\r?\n/g;
	let pieces: string[] = [];
	// The longest separator is four characters, so keeping the last three
	// characters of pending text is enough to find one that straddles chunks.
	let tail = "";
	let totalBytes = 0;
	// Bytes received but not yet emitted as a frame. Undecoded partial
	// characters are included, which keeps the bound conservative.
	let pendingBytes = 0;
	const onAbort = () => void reader.cancel().catch(() => undefined);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const chunk = await reader.read();
			signal?.throwIfAborted();
			let text = "";
			if (chunk.value) {
				totalBytes += chunk.value.byteLength;
				if (totalBytes > maxStreamBytes) throw new SseLimitError("stream");
				pendingBytes += chunk.value.byteLength;
				text = decoder.decode(chunk.value, { stream: !chunk.done });
			}
			if (chunk.done) text += decoder.decode();

			if (hasSeparator.test(tail + text)) {
				const buffer = pieces.join("") + text;
				pieces = [];
				let start = 0;
				separator.lastIndex = 0;
				let match = separator.exec(buffer);
				while (match) {
					const frame = buffer.slice(start, match.index);
					const frameBytes = Buffer.byteLength(frame);
					if (frameBytes > maxFrameBytes) throw new SseLimitError("frame");
					pendingBytes -= frameBytes + match[0].length;
					start = separator.lastIndex;
					yield frame;
					match = separator.exec(buffer);
				}
				const rest = buffer.slice(start);
				if (rest) pieces.push(rest);
				tail = rest.slice(-3);
			} else if (text) {
				pieces.push(text);
				tail = (tail + text).slice(-3);
			}
			if (pendingBytes > maxFrameBytes) throw new SseLimitError("frame");
			if (chunk.done) {
				const rest = pieces.join("");
				if (rest.trim()) yield rest;
				return;
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		// Cancelling after a normal end is a no-op; after an early return by the
		// consumer it releases the connection instead of draining it.
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export interface SseFrame {
	/** The `event:` field, or an empty string when the frame has none. */
	event: string;
	/** All `data:` lines joined with newlines, trimmed. */
	data: string;
}

/**
 * Splits one frame into its event name and data. Frames without data, and the
 * `[DONE]` sentinel some servers send, carry nothing to act on and return
 * undefined. JSON parsing stays with the caller, which owns the error wording.
 */
export function parseSseFrame(frame: string): SseFrame | undefined {
	let event = "";
	const dataLines: string[] = [];
	for (const line of frame.split(/\r?\n/)) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:"))
			dataLines.push(line.slice(5).trimStart());
	}
	if (dataLines.length === 0) return undefined;
	const data = dataLines.join("\n").trim();
	if (!data || data === "[DONE]") return undefined;
	return { event, data };
}
