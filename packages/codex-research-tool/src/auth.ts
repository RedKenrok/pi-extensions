export const OPENAI_CODEX_PROVIDER = "openai-codex";

export type AuthUnavailableReason =
	| "missing_oauth"
	| "refresh_failed"
	| "missing_account_id"
	| "check_timeout"
	| "unsupported_pi";

export type AuthResult =
	| { kind: "ready"; accessToken: string; accountId: string }
	| { kind: "unavailable"; reason: AuthUnavailableReason; message: string };

export interface StoredCredential {
	type?: unknown;
	access?: unknown;
	accountId?: unknown;
}

export interface AuthDependencies {
	readCredential():
		| StoredCredential
		| undefined
		| Promise<StoredCredential | undefined>;
	resolveAccessToken(signal?: AbortSignal): Promise<string | undefined>;
}

export interface AuthCheckOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

const messages: Record<AuthUnavailableReason, string> = {
	missing_oauth:
		"Research unavailable: sign in with /login openai-codex, then run /research refresh.",
	refresh_failed:
		"Research needs you to sign in again. Run /login openai-codex, then /research refresh.",
	missing_account_id:
		"Research needs you to sign in again. Run /login openai-codex, then /research refresh.",
	check_timeout:
		"Research could not check authentication. Run /research refresh to try again.",
	unsupported_pi:
		"Research is disabled because this Pi version is unsupported. Install a compatible Pi 0.85.x release.",
};

function unavailable(reason: AuthUnavailableReason): AuthResult {
	return { kind: "unavailable", reason, message: messages[reason] };
}

function nonemptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

export function extractAccountIdFromToken(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(
			Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
		) as Record<string, unknown>;
		const authClaim = payload["https://api.openai.com/auth"];
		if (!authClaim || typeof authClaim !== "object") return undefined;
		return nonemptyString(
			(authClaim as Record<string, unknown>).chatgpt_account_id,
		);
	} catch {
		return undefined;
	}
}

function credentialAccountId(
	credential: StoredCredential | undefined,
	fallbackToken?: string,
): string | undefined {
	return (
		nonemptyString(credential?.accountId) ??
		(fallbackToken ? extractAccountIdFromToken(fallbackToken) : undefined)
	);
}

function abortResult(): AuthResult {
	return unavailable("check_timeout");
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

export class AuthAdapter {
	private inFlight: Promise<AuthResult> | undefined;
	private readonly pendingRefreshes = new Set<Promise<unknown>>();
	private disposed = false;
	private readonly dependencies: AuthDependencies;

	constructor(dependencies: AuthDependencies) {
		this.dependencies = dependencies;
	}

	dispose(): void {
		this.disposed = true;
	}

	/**
	 * Invalidate only an idle result. An active flight may still be before its
	 * refresh phase, so never abandon it in favor of a duplicate operation.
	 */
	invalidate(): void {
		if (this.inFlight) return;
		this.inFlight = undefined;
	}

	check(options: AuthCheckOptions = {}): Promise<AuthResult> {
		if (this.disposed || options.signal?.aborted) {
			return Promise.resolve(abortResult());
		}
		if (!this.inFlight) {
			const operation = this.runBounded(options.timeoutMs ?? 5_000);
			this.inFlight = operation;
			void operation.then(async () => {
				while (this.pendingRefreshes.size > 0) {
					await Promise.allSettled([...this.pendingRefreshes]);
				}
				if (this.inFlight === operation) {
					this.inFlight = undefined;
				}
			});
		}
		return this.waitForCaller(this.inFlight, options.signal);
	}

	private async waitForCaller(
		promise: Promise<AuthResult>,
		signal?: AbortSignal,
	): Promise<AuthResult> {
		if (!signal) return promise;
		if (signal.aborted) return abortResult();
		return new Promise((resolve) => {
			const onAbort = () => resolve(abortResult());
			signal.addEventListener("abort", onAbort, { once: true });
			void promise.then((result) => {
				signal.removeEventListener("abort", onAbort);
				resolve(result);
			});
		});
	}

	private async runBounded(timeoutMs: number): Promise<AuthResult> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await this.resolveConsistent(controller.signal);
		} catch {
			return controller.signal.aborted
				? unavailable("check_timeout")
				: unavailable("refresh_failed");
		} finally {
			clearTimeout(timer);
		}
	}

	private async resolveConsistent(signal: AbortSignal): Promise<AuthResult> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (this.disposed || signal.aborted) return unavailable("check_timeout");
			const before = await withAbort(
				Promise.resolve(this.dependencies.readCredential()),
				signal,
			);
			if (before?.type !== "oauth") return unavailable("missing_oauth");

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
				if (signal.aborted) return unavailable("check_timeout");
				return unavailable("refresh_failed");
			}
			if (!token) return unavailable("refresh_failed");

			const after = await withAbort(
				Promise.resolve(this.dependencies.readCredential()),
				signal,
			);
			if (after?.type !== "oauth") return unavailable("missing_oauth");
			const beforeId = credentialAccountId(
				before,
				nonemptyString(before.access),
			);
			const afterId = credentialAccountId(after, token);
			if (beforeId && afterId && beforeId !== afterId) {
				if (attempt === 0) continue;
				return unavailable("refresh_failed");
			}
			if (!afterId) return unavailable("missing_account_id");
			if (this.disposed || signal.aborted) return unavailable("check_timeout");
			return { kind: "ready", accessToken: token, accountId: afterId };
		}
		return unavailable("refresh_failed");
	}
}
