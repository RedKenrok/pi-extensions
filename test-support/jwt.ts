// Unsigned tokens are enough: the extensions only read the account claim and
// never verify signatures, because Pi has already validated the credential.
export function jwt(accountId: unknown): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}
