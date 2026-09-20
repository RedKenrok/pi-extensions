import { DEFAULT_USER_AGENT } from "./constants.ts";

export const findHeaderKey = (
	headers: Record<string, string>,
	name: string,
): string | undefined => {
	return Object.keys(headers).find(
		(key) => key.toLowerCase() === name.toLowerCase(),
	);
};

export const buildHeaders = (
	headers?: Record<string, string>,
): Record<string, string> => {
	const finalHeaders = { ...(headers ?? {}) };

	const userAgentKey = findHeaderKey(finalHeaders, "user-agent");

	if (!userAgentKey) {
		finalHeaders["User-Agent"] = DEFAULT_USER_AGENT;
	}

	return finalHeaders;
};
