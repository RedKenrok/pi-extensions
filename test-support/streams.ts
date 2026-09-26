export function sseEvent(type: string, data: unknown, crlf = false): string {
	const newline = crlf ? "\r\n" : "\n";
	return `event: ${type}${newline}data: ${JSON.stringify(data)}${newline}${newline}`;
}

// Chunk sizes let tests split multi-byte characters and SSE separators across
// reads, which is where incremental parsers usually break.
export function chunkedResponse(
	text: string,
	chunks?: number[],
	init: ResponseInit = {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	},
): Response {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	// An index rather than shift() keeps streams of many tiny chunks linear.
	let chunkIndex = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= bytes.length) return controller.close();
				const size = chunks?.[chunkIndex++] ?? bytes.length;
				controller.enqueue(bytes.slice(offset, offset + size));
				offset += size;
			},
		}),
		init,
	);
}
