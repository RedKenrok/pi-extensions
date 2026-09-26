import assert from "node:assert/strict";
import test from "node:test";
import {
	CODEX_MODELS_URL,
	CODEX_RESPONSES_URL,
	codexRequestHeaders,
} from "../src/codex.ts";

test("endpoints stay on the fixed chatgpt.com origin", () => {
	assert.equal(
		CODEX_RESPONSES_URL,
		"https://chatgpt.com/backend-api/codex/responses",
	);
	assert.equal(
		CODEX_MODELS_URL,
		"https://chatgpt.com/backend-api/codex/models",
	);
});

test("request headers pair the bearer token with the account id", () => {
	assert.deepEqual(codexRequestHeaders({ accessToken: "t", accountId: "a" }), {
		Accept: "text/event-stream",
		Authorization: "Bearer t",
		"ChatGPT-Account-ID": "a",
		"Content-Type": "application/json",
		"OpenAI-Beta": "responses=experimental",
		originator: "pi",
	});
});
