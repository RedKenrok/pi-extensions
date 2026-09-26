export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function nonemptyString(value: unknown): string | undefined {
	const trimmed = stringValue(value)?.trim();
	return trimmed || undefined;
}
