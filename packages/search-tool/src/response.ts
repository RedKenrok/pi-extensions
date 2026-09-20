export const readResponseWithLimit = async (
	response: Response,
	maxSize: number,
): Promise<Uint8Array> => {
	const reader = response.body?.getReader();

	if (!reader) {
		return new Uint8Array();
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		total += value.length;
		if (total > maxSize) {
			await reader.cancel();

			throw Object.assign(
				new Error(
					`Response size (${total} bytes) exceeds maximum allowed size (${maxSize} bytes)`,
				),
				{
					errorType: "size_limit",
					maxSize,
					actualSize: total,
				},
			);
		}
		chunks.push(value);
	}

	const result = new Uint8Array(total);

	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}

	return result;
};
