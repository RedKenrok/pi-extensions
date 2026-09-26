import assert from "node:assert/strict";
import test from "node:test";
import { deferred, nextTurn } from "../../../test-support/async.ts";
import { jwt } from "../../../test-support/jwt.ts";
import {
	AuthAdapter,
	extractAccountIdFromToken,
	type StoredCredential,
} from "../src/auth.ts";

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
	const refresh = deferred<string>();
	let resolves = 0;
	const adapter = new AuthAdapter({
		readCredential: () => ({ type: "oauth", accountId: "account" }),
		resolveAccessToken: () => {
			resolves += 1;
			return refresh.promise;
		},
	});
	const pending = Promise.all([adapter.check(), adapter.check()]);
	refresh.resolve(jwt("account"));
	const [first, second] = await pending;
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

test("bounds a hung refresh and supports caller cancellation", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const adapter = new AuthAdapter({
		readCredential: () => ({ type: "oauth", accountId: "account" }),
		resolveAccessToken: async () => new Promise<string>(() => {}),
	});
	const pending = adapter.check({ timeoutMs: 10 });
	await nextTurn();
	t.mock.timers.tick(10);
	const timedOut = await pending;
	assert.equal(timedOut.kind, "unavailable");
	if (timedOut.kind === "unavailable")
		assert.equal(timedOut.reason, "check_timeout");

	const controller = new AbortController();
	controller.abort();
	const cancelled = await adapter.check({ signal: controller.signal });
	assert.equal(cancelled.kind, "unavailable");
	if (cancelled.kind === "unavailable")
		assert.equal(cancelled.reason, "check_cancelled");
});

test("does not overlap a timed-out refresh", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
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

	const pending = adapter.check({ timeoutMs: 10 });
	await nextTurn();
	t.mock.timers.tick(10);
	const timedOut = await pending;
	assert.equal(timedOut.kind, "unavailable");
	if (timedOut.kind === "unavailable")
		assert.equal(timedOut.reason, "check_timeout");
	await nextTurn();

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
		assert.equal(cancelledResult.reason, "check_cancelled");
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

test("handles a late refresh rejection after timeout safely", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
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

	const pending = adapter.check({ timeoutMs: 10 });
	await nextTurn();
	t.mock.timers.tick(10);
	const timedOut = await pending;
	assert.equal(timedOut.kind, "unavailable");
	if (timedOut.kind === "unavailable")
		assert.equal(timedOut.reason, "check_timeout");
	await nextTurn();
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

function countingAdapter(options: {
	credential: () => StoredCredential | undefined;
	now?: () => number;
}) {
	let refreshes = 0;
	const adapter = new AuthAdapter({
		readCredential: options.credential,
		resolveAccessToken: async () => {
			refreshes += 1;
			return jwt("account");
		},
		...(options.now ? { now: options.now } : {}),
	});
	return { adapter, refreshes: () => refreshes };
}

test("reuses a verified result while the stored credential is unchanged", async () => {
	let clock = 1_000;
	const { adapter, refreshes } = countingAdapter({
		credential: () => ({ type: "oauth", accountId: "account" }),
		now: () => clock,
	});
	assert.equal((await adapter.check()).kind, "ready");
	assert.equal((await adapter.check()).kind, "ready");
	assert.equal(refreshes(), 1);
	clock += 30_000;
	assert.equal((await adapter.check()).kind, "ready");
	assert.equal(refreshes(), 2, "the cache expires after its TTL");
});

test("a changed or removed stored credential bypasses the cache", async () => {
	let credential: StoredCredential | undefined = {
		type: "oauth",
		accountId: "account",
		access: "first",
	};
	const { adapter, refreshes } = countingAdapter({
		credential: () => credential,
	});
	assert.equal((await adapter.check()).kind, "ready");
	credential = { type: "oauth", accountId: "account", access: "second" };
	assert.equal((await adapter.check()).kind, "ready");
	assert.equal(refreshes(), 2);
	credential = undefined;
	const loggedOut = await adapter.check();
	assert.equal(loggedOut.kind, "unavailable");
	if (loggedOut.kind === "unavailable")
		assert.equal(loggedOut.reason, "missing_oauth");
});

test("invalidate clears the cache and dispose disables it", async () => {
	const { adapter, refreshes } = countingAdapter({
		credential: () => ({ type: "oauth", accountId: "account" }),
	});
	await adapter.check();
	adapter.invalidate();
	await adapter.check();
	assert.equal(refreshes(), 2);
	adapter.dispose();
	const disposed = await adapter.check();
	assert.equal(disposed.kind, "unavailable");
	if (disposed.kind === "unavailable")
		assert.equal(disposed.reason, "check_cancelled");
});

test("never caches a token close to its recorded expiry", async () => {
	const clock = 1_000_000;
	const { adapter, refreshes } = countingAdapter({
		credential: () => ({
			type: "oauth",
			accountId: "account",
			expires: clock + 30_000,
		}),
		now: () => clock,
	});
	await adapter.check();
	await adapter.check();
	assert.equal(refreshes(), 2);
});

test("a flight started before invalidation answers callers but is not cached", async () => {
	const refresh = deferred<string>();
	let refreshes = 0;
	const adapter = new AuthAdapter({
		readCredential: () => ({ type: "oauth", accountId: "account" }),
		resolveAccessToken: () => {
			refreshes += 1;
			return refreshes === 1
				? refresh.promise
				: Promise.resolve(jwt("account"));
		},
	});
	const first = adapter.check();
	await nextTurn();
	adapter.invalidate();
	refresh.resolve(jwt("account"));
	assert.equal((await first).kind, "ready");
	await nextTurn();
	assert.equal((await adapter.check()).kind, "ready");
	assert.equal(refreshes, 2);
});

test("a later caller with a longer timeout extends the shared flight", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const refresh = deferred<string>();
	const adapter = new AuthAdapter({
		readCredential: () => ({ type: "oauth", accountId: "account" }),
		resolveAccessToken: () => refresh.promise,
	});
	const short = adapter.check({ timeoutMs: 10 });
	const long = adapter.check({ timeoutMs: 1_000 });
	t.mock.timers.tick(10);
	const shortResult = await short;
	assert.equal(shortResult.kind, "unavailable");
	if (shortResult.kind === "unavailable")
		assert.equal(shortResult.reason, "check_timeout");
	refresh.resolve(jwt("account"));
	assert.equal((await long).kind, "ready");
});

test("a caller signal that aborts while reading a cached credential is cancelled", async () => {
	let cachedRead = false;
	const pendingRead = deferred<StoredCredential>();
	const adapter = new AuthAdapter({
		readCredential: () => {
			if (cachedRead) return pendingRead.promise;
			return { type: "oauth", accountId: "account" };
		},
		resolveAccessToken: async () => jwt("account"),
	});
	assert.equal((await adapter.check()).kind, "ready");
	cachedRead = true;
	const controller = new AbortController();
	const pending = adapter.check({ signal: controller.signal });
	controller.abort();
	const result = await pending;
	assert.equal(result.kind, "unavailable");
	if (result.kind === "unavailable")
		assert.equal(result.reason, "check_cancelled");
});
