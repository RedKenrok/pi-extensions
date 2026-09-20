import type { AvailabilityBlock, Clock } from "./types.ts";

const SECRET_PATTERNS = [
	/\bbearer\s+[^\s,;]+/gi,
	/\b(?:sk|key|token|bearer)[-_][A-Za-z0-9._-]{8,}\b/gi,
	/authorization\s*:\s*(?:bearer\s+)?[^\s,;]+/gi,
];

export function sanitize(message: string, maxBytes = 2048): string {
	let value = Buffer.from(message, "utf8")
		.subarray(0, maxBytes)
		.toString("utf8");
	for (const pattern of SECRET_PATTERNS)
		value = value.replace(pattern, "[redacted]");
	return value;
}

function reliableDate(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value > 10_000_000_000 ? value : value * 1000;
		return new Date(ms).toISOString();
	}
	if (typeof value === "string") {
		const ms = Date.parse(value);
		if (Number.isFinite(ms)) return new Date(ms).toISOString();
	}
	return undefined;
}

export function normalizeAvailability(
	error: unknown,
	scopeKey: string,
	now = new Date(),
): AvailabilityBlock {
	const object =
		error && typeof error === "object"
			? (error as Record<string, unknown>)
			: {};
	const status = Number(object.status ?? object.statusCode ?? 0);
	const code = String(object.code ?? "").toLowerCase();
	const message = sanitize(
		String(object.message ?? error ?? "unknown provider error"),
	);
	const lower = message.toLowerCase();
	const retryAt = reliableDate(
		object.retryAt ?? object.resetAt ?? object.reset_at,
	);
	const retryAfter = Number(object.retryAfter ?? object.retry_after);
	const retryAfterDate =
		Number.isFinite(retryAfter) && retryAfter >= 0
			? new Date(now.getTime() + retryAfter * 1000).toISOString()
			: undefined;
	const observedRetryAt = retryAt ?? retryAfterDate;
	const provenance = retryAt
		? ("provider_reset" as const)
		: retryAfterDate
			? ("retry_after" as const)
			: ("unknown" as const);
	if (
		status === 401 ||
		code.includes("auth") ||
		/login|credential.*expired|unauth/.test(lower)
	)
		return {
			kind: "auth_required",
			scopeKey,
			provenance: "unknown",
			automaticRetryAllowed: false,
		};
	if (status === 403 || /access denied|not permitted|forbidden/.test(lower))
		return {
			kind: "access_denied",
			scopeKey,
			provenance: "unknown",
			automaticRetryAllowed: false,
		};
	if (/weekly|month(?:ly)? limit|account restriction/.test(lower))
		return {
			kind: "usage_exhausted",
			scopeKey,
			...(observedRetryAt ? { retryAt: observedRetryAt } : {}),
			provenance,
			automaticRetryAllowed: Boolean(observedRetryAt),
		};
	if (
		/usage (?:limit|exhausted)|quota exhausted|capacity window|reset at/.test(
			lower,
		)
	)
		return {
			kind: "usage_exhausted",
			scopeKey,
			...(observedRetryAt ? { retryAt: observedRetryAt } : {}),
			provenance,
			automaticRetryAllowed: true,
		};
	if (status === 429 || code.includes("rate_limit"))
		return {
			kind: "short_rate_limit",
			scopeKey,
			...(observedRetryAt ? { retryAt: observedRetryAt } : {}),
			provenance,
			automaticRetryAllowed: true,
		};
	if (status >= 500 || /timeout|temporar|connection reset|network/.test(lower))
		return {
			kind: "transient",
			scopeKey,
			provenance: "unknown",
			automaticRetryAllowed: true,
		};
	return {
		kind: "unknown",
		scopeKey,
		provenance: "unknown",
		automaticRetryAllowed: false,
	};
}

export function nextProbeAt(
	clock: Clock,
	attempts: number,
	reliableRetryAt?: string,
	jitter = 0,
): string {
	if (reliableRetryAt)
		return new Date(
			Date.parse(reliableRetryAt) + Math.max(0, jitter),
		).toISOString();
	const delay = Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempts));
	return new Date(
		clock.now().getTime() + delay + Math.max(0, jitter),
	).toISOString();
}

export const MAX_AUTOMATIC_PROBES = 6;
