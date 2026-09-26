import { isRecord, nonemptyString } from "./record.ts";

const AUTH_CLAIM = "https://api.openai.com/auth";

/**
 * Reads the ChatGPT account id claim from an OpenAI OAuth access token. The
 * signature is not verified: Pi already validated the credential, and the id
 * is only used to address requests and to fingerprint checkpoints.
 */
export function chatgptAccountIdFromToken(token: string): string | undefined {
	const parts = token.split(".");
	// A JWT always has header, payload, and signature segments; anything else
	// is not a token these extensions understand.
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const payload: unknown = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		);
		if (!isRecord(payload)) return undefined;
		const claim = payload[AUTH_CLAIM];
		return isRecord(claim)
			? nonemptyString(claim.chatgpt_account_id)
			: undefined;
	} catch {
		return undefined;
	}
}
