import { createHash, randomBytes, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
	return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function stableHash(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" ? value : JSON.stringify(value))
		.digest("hex");
}

export function newSecret(): string {
	return randomBytes(32).toString("base64url");
}

export function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
		.join(",")}}`;
}
