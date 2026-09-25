import assert from "node:assert/strict";
import test from "node:test";
import { AuthAdapter, extractAccountIdFromToken } from "../src/auth.ts";

function jwt(accountId: unknown): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("extracts only the ChatGPT account claim from a JWT", () => {
	assert.equal(extractAccountIdFromToken(jwt(" account-1 ")), "account-1");
	assert.equal(extractAccountIdFromToken(jwt("   ")), undefined);
	assert.equal(extractAccountIdFromToken(jwt(42)), undefined);
	assert.equal(extractAccountIdFromToken("opaque-token"), undefined);
	assert.equal(extractAccountIdFromToken("a.!!!!.c"), undefined);
});

test("stored OAuth account ID takes precedence over the token claim", async () => {
	const adapter = new AuthAdapter({
		readCredential: () => ({
			type: "oauth",
			access: jwt("token-account"),
			accountId: " stored-account ",
		}),
		resolveAccessToken: async () => jwt("token-account"),
	});
	assert.deepEqual(await adapter.check(), {
		kind: "ready",
		accessToken: jwt("token-account"),
		accountId: "stored-account",
	});
});

test("falls back to the refreshed access token claim", async () => {
	const adapter = new AuthAdapter({
		readCredential: () => ({ type: "oauth" }),
		resolveAccessToken: async () => jwt("fallback-account"),
	});
	const result = await adapter.check();
	assert.equal(result.kind, "ready");
	if (result.kind === "ready")
		assert.equal(result.accountId, "fallback-account");
});

test("rejects missing, API-key, malformed, and account-less credentials", async (t) => {
	for (const [name, credential, token, reason] of [
		["missing", undefined, jwt("a"), "missing_oauth"],
		["API key", { type: "api_key", key: "secret" }, jwt("a"), "missing_oauth"],
		[
			"blank account",
			{ type: "oauth", accountId: " " },
			"opaque",
			"missing_account_id",
		],
		[
			"wrong account type",
			{ type: "oauth", accountId: 7 },
			jwt(undefined),
			"missing_account_id",
		],
	] as const) {
		await t.test(name, async () => {
			const adapter = new AuthAdapter({
				readCredential: () => credential,
				resolveAccessToken: async () => token,
			});
			const result = await adapter.check();
			assert.equal(result.kind, "unavailable");
			if (result.kind === "unavailable") assert.equal(result.reason, reason);
		});
	}
});

test("rereads refreshed credentials and accepts newly stored account metadata", async () => {
	let reads = 0;
	const adapter = new AuthAdapter({
		readCredential: () =>
			reads++ === 0
				? { type: "oauth", access: jwt("same") }
				: { type: "oauth", accountId: "same" },
		resolveAccessToken: async () => "new-opaque-access-token",
	});
	const result = await adapter.check();
	assert.equal(result.kind, "ready");
	if (result.kind === "ready") assert.equal(result.accountId, "same");
});

test("retries one account change and fails closed if it remains unstable", async () => {
	let reads = 0;
	let resolves = 0;
	const adapter = new AuthAdapter({
		readCredential: () => ({
			type: "oauth",
			accountId: `account-${++reads}`,
		}),
		resolveAccessToken: async () => {
			resolves += 1;
			return jwt(`token-${resolves}`);
		},
	});
	const result = await adapter.check();
	assert.equal(result.kind, "unavailable");
	if (result.kind === "unavailable")
		assert.equal(result.reason, "refresh_failed");
	assert.equal(resolves, 2);
});

test("serializes concurrent token refreshes", async () => {
	let resolves = 0;
	const adapter = new AuthAdapter({
		readCredential: () => ({ type: "oauth", accountId: "account" }),
		resolveAccessToken: async () => {
			resolves += 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return jwt("account");
		},
	});
	const [first, second] = await Promise.all([adapter.check(), adapter.check()]);
	assert.equal(first.kind, "ready");
	assert.equal(second.kind, "ready");
	assert.equal(resolves, 1);
});

test("invalidation does not abandon a check awaiting credentials", async () => {
	const credential = deferred<{ type: "oauth"; accountId: string }>();
	let refreshes = 0;
	const adapter = new AuthAdapter({
		readCredential: () => credential.promise,
		resolveAccessToken: async () => {
			refreshes += 1;
			return jwt("account");
		},
	});

	const first = adapter.check();
	await nextTurn();
	adapter.invalidate();
	const second = adapter.check();
	credential.resolve({ type: "oauth", accountId: "account" });

	assert.equal((await first).kind, "ready");
	assert.equal((await second).kind, "ready");
	assert.equal(refreshes, 1);
});

test("bounds a hung refresh and supports caller cancellation", async () => {
	const adapter = new AuthAdapter({
		readCredential: () => ({ type: "oauth", accountId: "account" }),
		resolveAccessToken: async () => new Promise<string>(() => {}),
	});
	const timedOut = await adapter.check({ timeoutMs: 10 });
	assert.equal(timedOut.kind, "unavailable");
	if (timedOut.kind === "unavailable")
		assert.equal(timedOut.reason, "check_timeout");

	const controller = new AbortController();
	controller.abort();
	const cancelled = await adapter.check({ signal: controller.signal });
	assert.equal(cancelled.kind, "unavailable");
});

test("does not overlap a timed-out refresh", async () => {
	const firstRefresh = deferred<string>();
	let refreshes = 0;
	const adapter = new AuthAdapter({
		readCredential: () => ({ type: "oauth", accountId: "account" }),
		resolveAccessToken: () => {
			refreshes += 1;
			return refreshes === 1
				? firstRefresh.promise
				: Promise.resolve(jwt("account"));
		},
	});

	const timedOut = await adapter.check({ timeoutMs: 10 });
	assert.equal(timedOut.kind, "unavailable");
	if (timedOut.kind === "unavailable")
		assert.equal(timedOut.reason, "check_timeout");

	adapter.invalidate();
	const overlapping = await adapter.check();
	assert.equal(overlapping.kind, "unavailable");
	if (overlapping.kind === "unavailable")
		assert.equal(overlapping.reason, "check_timeout");
	assert.equal(refreshes, 1);

	firstRefresh.resolve(jwt("account"));
	await nextTurn();
	const recovered = await adapter.check();
	assert.equal(recovered.kind, "ready");
	assert.equal(refreshes, 2);
});

test("cancelling one concurrent caller does not cancel the shared refresh", async () => {
	const refresh = deferred<string>();
	let refreshes = 0;
	const adapter = new AuthAdapter({
		readCredential: () => ({ type: "oauth", accountId: "account" }),
		resolveAccessToken: () => {
			refreshes += 1;
			return refresh.promise;
		},
	});
	const controller = new AbortController();
	const cancelled = adapter.check({ signal: controller.signal });
	const shared = adapter.check();

	controller.abort();
	const cancelledResult = await cancelled;
	assert.equal(cancelledResult.kind, "unavailable");
	if (cancelledResult.kind === "unavailable")
		assert.equal(cancelledResult.reason, "check_timeout");
	let sharedSettled = false;
	void shared.then(() => {
		sharedSettled = true;
	});
	await Promise.resolve();
	assert.equal(sharedSettled, false);

	refresh.resolve(jwt("account"));
	const sharedResult = await shared;
	assert.equal(sharedResult.kind, "ready");
	assert.equal(refreshes, 1);
});

test("handles a late refresh rejection after timeout safely", async () => {
	const lateRefresh = deferred<string>();
	let refreshes = 0;
	const adapter = new AuthAdapter({
		readCredential: () => ({ type: "oauth", accountId: "account" }),
		resolveAccessToken: () => {
			refreshes += 1;
			return refreshes === 1
				? lateRefresh.promise
				: Promise.resolve(jwt("account"));
		},
	});

	const timedOut = await adapter.check({ timeoutMs: 10 });
	assert.equal(timedOut.kind, "unavailable");
	if (timedOut.kind === "unavailable")
		assert.equal(timedOut.reason, "check_timeout");
	lateRefresh.reject(new Error("late refresh failure"));
	await nextTurn();

	const recovered = await adapter.check();
	assert.equal(recovered.kind, "ready");
	assert.equal(refreshes, 2);
});

test("sanitized failures never expose token or account secrets", async () => {
	const secretToken = "token-super-secret";
	const secretAccount = "account-super-secret";
	const adapter = new AuthAdapter({
		readCredential: () => ({ type: "oauth", accountId: secretAccount }),
		resolveAccessToken: async () => {
			throw new Error(`${secretToken}:${secretAccount}`);
		},
	});
	const serialized = JSON.stringify(await adapter.check());
	assert.equal(serialized.includes(secretToken), false);
	assert.equal(serialized.includes(secretAccount), false);
});
