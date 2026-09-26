import { BodyTooLargeError, readBodyWithLimit } from "shared/body";

/**
 * Reads the body with a hard byte limit, reporting an overrun as the tool's
 * `size_limit` error so callers see the same shape as a Content-Length
 * rejection.
 */
export const readResponseWithLimit = async (
	response: Response,
	maxSize: number,
	signal?: AbortSignal,
): Promise<Uint8Array> => {
	try {
		return await readBodyWithLimit(response.body, maxSize, signal);
	} catch (error) {
		if (!(error instanceof BodyTooLargeError)) throw error;
		throw Object.assign(new Error(error.message), {
			errorType: "size_limit",
			maxSize: error.maxBytes,
			actualSize: error.actualBytes,
		});
	}
};
