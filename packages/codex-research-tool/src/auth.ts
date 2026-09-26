import { chatgptAccountIdFromToken } from "shared/jwt";
import { SIGN_IN, SIGN_IN_AGAIN } from "./errors.ts";
import {
	AUTH_CACHE_TTL_MS,
	AUTH_EXPIRY_MARGIN_MS,
	AVAILABILITY_TIMEOUT_MS,
} from "./limits.ts";
import { nonemptyString } from "./util.ts";

export const OPENAI_CODEX_PROVIDER = "openai-codex";

export type AuthUnavailableReason =
	| "missing_oauth"
	| "refresh_failed"
	| "missing_account_id"
	| "check_timeout"
	| "check_cancelled";

export interface ReadyAuth {
	kind: "ready";
	accessToken: string;
	accountId: string;
}

export type AuthResult =
	| ReadyAuth
	| { kind: "unavailable"; reason: AuthUnavailableReason; message: string };

export interface StoredCredential {
	type?: unknown;
	access?: unknown;
	accountId?: unknown;
	expires?: unknown;
}

export interface AuthDependencies {
	readCredential():
		| StoredCredential
		| undefined
		| Promise<StoredCredential | undefined>;
	resolveAccessToken(signal?: AbortSignal): Promise<string | undefined>;
	now?: () => number;
}

export interface AuthCheckOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

const messages: Record<AuthUnavailableReason, string> = {
	missing_oauth: SIGN_IN,
	refresh_failed: SIGN_IN_AGAIN,
	missing_account_id: SIGN_IN_AGAIN,
	check_timeout:
		"Research could not check authentication. Run /research refresh to try again.",
	check_cancelled: "The research authentication check was cancelled.",
};

function unavailable(reason: AuthUnavailableReason): AuthResult {
	return { kind: "unavailable", reason, message: messages[reason] };
}

export const extractAccountIdFromToken = chatgptAccountIdFromToken;

function credentialAccountId(
	credential: StoredCredential | undefined,
	fallbackToken?: string,
): string | undefined {
	return (
		nonemptyString(credential?.accountId) ??
		(fallbackToken ? extractAccountIdFromToken(fallbackToken) : undefined)
	);
}

// Any change to these fields means Pi refreshed, replaced, or removed the
// login, so a cached result derived from the previous values is no longer
// trustworthy.
function credentialKey(credential: StoredCredential | undefined): string {
	return JSON.stringify([
		credential?.type,
		credential?.access,
		credential?.accountId,
		credential?.expires,
	]);
}

async function withAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) throw signal.reason;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

interface Flight {
	promise: Promise<AuthResult>;
	settled: boolean;
	deadline: number;
	arm(): void;
}

interface CachedAuth {
	result: ReadyAuth;
	key: string;
	expiresAt: number;
}

export class AuthAdapter {
	private flight: Flight | undefined;
	private cached: CachedAuth | undefined;
	// Bumped by invalidate() so a flight that started before the invalidation
	// can still answer its callers but cannot repopulate the cache.
	private epoch = 0;
	private readonly pendingRefreshes = new Set<Promise<unknown>>();
	private disposed = false;
	private readonly dependencies: AuthDependencies;
	private readonly now: () => number;

	constructor(dependencies: AuthDependencies) {
		this.dependencies = dependencies;
		this.now = dependencies.now ?? Date.now;
	}

	dispose(): void {
		this.disposed = true;
		this.cached = undefined;
	}

	/**
	 * Forget the cached result so the next check refreshes the token. An active
	 * flight is never abandoned: it may already be inside Pi's serialized
	 * refresh, and starting a second one would race it.
	 */
	invalidate(): void {
		this.cached = undefined;
		this.epoch += 1;
	}

	check(options: AuthCheckOptions = {}): Promise<AuthResult> {
		if (this.disposed || options.signal?.aborted) {
			return Promise.resolve(unavailable("check_cancelled"));
		}
		const timeoutMs = options.timeoutMs ?? AVAILABILITY_TIMEOUT_MS;
		const cached = this.cached;
		if (cached && this.now() < cached.expiresAt) {
			return this.checkCached(cached, options.signal, timeoutMs);
		}
		return this.checkFresh(options.signal, timeoutMs);
	}

	private async checkCached(
		cached: CachedAuth,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<AuthResult> {
		const bound = AbortSignal.any(
			[signal, AbortSignal.timeout(timeoutMs)].filter(
				(value): value is AbortSignal => value !== undefined,
			),
		);
		let credential: StoredCredential | undefined;
		try {
			credential = await withAbort(
				Promise.resolve(this.dependencies.readCredential()),
				bound,
			);
		} catch {
			if (signal?.aborted) return unavailable("check_cancelled");
			if (bound.aborted) return unavailable("check_timeout");
			credential = undefined;
		}
		if (
			!this.disposed &&
			this.cached === cached &&
			this.now() < cached.expiresAt &&
			credentialKey(credential) === cached.key
		) {
			return cached.result;
		}
		if (this.cached === cached) this.cached = undefined;
		return this.checkFresh(signal, timeoutMs);
	}

	private checkFresh(
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<AuthResult> {
		let flight = this.flight;
		if (!flight) {
			flight = this.startFlight(timeoutMs);
		} else if (!flight.settled) {
			// A caller willing to wait longer extends the shared flight rather than
			// inheriting whatever timeout the first caller happened to choose.
			const deadline = Date.now() + timeoutMs;
			if (deadline > flight.deadline) {
				flight.deadline = deadline;
				flight.arm();
			}
		}
		return this.waitForCaller(flight.promise, signal, timeoutMs);
	}

	private startFlight(timeoutMs: number): Flight {
		const controller = new AbortController();
		const epoch = this.epoch;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const flight: Flight = {
			promise: Promise.resolve(unavailable("check_timeout")),
			settled: false,
			deadline: Date.now() + timeoutMs,
			arm() {
				clearTimeout(timer);
				timer = setTimeout(
					() => controller.abort(),
					Math.max(0, flight.deadline - Date.now()),
				);
			},
		};
		flight.arm();
		flight.promise = this.resolveConsistent(controller.signal)
			.then(
				({ result, credential }) => {
					if (result.kind === "ready" && epoch === this.epoch)
						this.remember(result, credential);
					return result;
				},
				() =>
					controller.signal.aborted
						? unavailable("check_timeout")
						: unavailable("refresh_failed"),
			)
			.finally(() => {
				flight.settled = true;
				clearTimeout(timer);
			});
		this.flight = flight;
		// The flight stays current until every refresh it started has settled,
		// so a timed-out check can never launch an overlapping refresh.
		void flight.promise.then(async () => {
			while (this.pendingRefreshes.size > 0) {
				await Promise.allSettled([...this.pendingRefreshes]);
			}
			if (this.flight === flight) this.flight = undefined;
		});
		return flight;
	}

	private remember(
		result: ReadyAuth,
		credential: StoredCredential | undefined,
	): void {
		if (this.disposed) return;
		const now = this.now();
		let expiresAt = now + AUTH_CACHE_TTL_MS;
		if (typeof credential?.expires === "number") {
			expiresAt = Math.min(
				expiresAt,
				credential.expires - AUTH_EXPIRY_MARGIN_MS,
			);
		}
		if (expiresAt > now) {
			this.cached = { result, key: credentialKey(credential), expiresAt };
		}
	}

	private waitForCaller(
		promise: Promise<AuthResult>,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<AuthResult> {
		return new Promise((resolve) => {
			const timer = setTimeout(
				() => finish(unavailable("check_timeout")),
				timeoutMs,
			);
			const onAbort = () => finish(unavailable("check_cancelled"));
			const finish = (result: AuthResult) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			void promise.then(finish);
		});
	}

	private async resolveConsistent(signal: AbortSignal): Promise<{
		result: AuthResult;
		credential?: StoredCredential | undefined;
	}> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (this.disposed || signal.aborted)
				return { result: unavailable("check_timeout") };
			const before = await withAbort(
				Promise.resolve(this.dependencies.readCredential()),
				signal,
			);
			if (before?.type !== "oauth")
				return { result: unavailable("missing_oauth") };

			let token: string | undefined;
			try {
				const refresh = Promise.resolve(
					this.dependencies.resolveAccessToken(signal),
				);
				this.pendingRefreshes.add(refresh);
				void refresh.then(
					() => this.pendingRefreshes.delete(refresh),
					() => this.pendingRefreshes.delete(refresh),
				);
				token = nonemptyString(await withAbort(refresh, signal));
			} catch {
				return {
					result: unavailable(
						signal.aborted ? "check_timeout" : "refresh_failed",
					),
				};
			}
			if (!token) return { result: unavailable("refresh_failed") };

			const after = await withAbort(
				Promise.resolve(this.dependencies.readCredential()),
				signal,
			);
			if (after?.type !== "oauth")
				return { result: unavailable("missing_oauth") };
			const beforeId = credentialAccountId(
				before,
				nonemptyString(before.access),
			);
			const afterId = credentialAccountId(after, token);
			if (beforeId && afterId && beforeId !== afterId) {
				if (attempt === 0) continue;
				return { result: unavailable("refresh_failed") };
			}
			if (!afterId) return { result: unavailable("missing_account_id") };
			if (this.disposed || signal.aborted)
				return { result: unavailable("check_timeout") };
			return {
				result: { kind: "ready", accessToken: token, accountId: afterId },
				credential: after,
			};
		}
		return { result: unavailable("refresh_failed") };
	}
}
