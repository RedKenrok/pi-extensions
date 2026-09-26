export const CODEX_ORIGIN = "https://chatgpt.com";
export const CODEX_BASE_URL = `${CODEX_ORIGIN}/backend-api`;
export const CODEX_RESPONSES_URL = `${CODEX_BASE_URL}/codex/responses`;
export const CODEX_MODELS_URL = `${CODEX_BASE_URL}/codex/models`;

export interface CodexAuth {
	accessToken: string;
	accountId: string;
}

/**
 * Headers every Codex subscription request needs. The bearer token and the
 * account id must travel together: the backend rejects either one alone.
 */
export function codexRequestHeaders(auth: CodexAuth): Record<string, string> {
	return {
		Accept: "text/event-stream",
		Authorization: `Bearer ${auth.accessToken}`,
		"ChatGPT-Account-ID": auth.accountId,
		"Content-Type": "application/json",
		"OpenAI-Beta": "responses=experimental",
		originator: "pi",
	};
}
