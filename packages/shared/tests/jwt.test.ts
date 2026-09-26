import assert from "node:assert/strict";
import test from "node:test";
import { jwt } from "../../../test-support/jwt.ts";
import { chatgptAccountIdFromToken } from "../src/jwt.ts";

test("reads and trims the ChatGPT account claim", () => {
	assert.equal(chatgptAccountIdFromToken(jwt(" account-1 ")), "account-1");
});

test("rejects tokens without exactly three segments or a usable claim", () => {
	const valid = jwt("account-1");
	const [header, payload] = valid.split(".");
	for (const token of [
		"",
		"opaque",
		`${header}.${payload}`,
		`${valid}.extra`,
		`${header}..signature`,
		`${header}.not-json.signature`,
		jwt(""),
		jwt(42),
		`${header}.${Buffer.from("[]").toString("base64url")}.signature`,
		`${header}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": "x" })).toString("base64url")}.signature`,
	])
		assert.equal(chatgptAccountIdFromToken(token), undefined, token);
});
