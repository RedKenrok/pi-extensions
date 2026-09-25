export const readResponseWithLimit = async (
	response: Response,
	maxSize: number,
	signal?: AbortSignal,
): Promise<Uint8Array> => {
	const reader = response.body?.getReader();

	if (!reader) {
		return new Uint8Array();
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	const abort = () => {
		void reader.cancel(signal?.reason).catch(() => undefined);
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			total += value.length;
			if (total > maxSize) {
				const error = Object.assign(
					new Error(
						`Response size (${total} bytes) exceeds maximum allowed size (${maxSize} bytes)`,
					),
					{ errorType: "size_limit", maxSize, actualSize: total },
				);
				throw error;
			}
			chunks.push(value);
		}
		if (chunks.length === 1 && chunks[0]) return chunks[0];
		const result = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	} catch (error) {
		void reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
};
