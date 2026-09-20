import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
	CONFIG_DIR_NAME,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { ContractError } from "./contract.ts";
import type { ProfileSnapshot, ReasoningLevel } from "./types.ts";

type Raw = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	reasoning?: unknown;
};
const levels = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function tools(value: unknown): string[] | undefined {
	const source = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	const result = source
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.trim())
		.filter(Boolean);
	return result.length ? [...new Set(result)] : undefined;
}
function inside(path: string, boundary: string): boolean {
	const relative = resolve(path).slice(resolve(boundary).length);
	return resolve(path) === resolve(boundary) || relative.startsWith(sep);
}
function load(
	dir: string,
	source: "user" | "project",
	boundary?: string,
): ProfileSnapshot[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	const values: ProfileSnapshot[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (
			!entry.name.endsWith(".md") ||
			(!entry.isFile() && !entry.isSymbolicLink())
		)
			continue;
		const path = join(dir, entry.name);
		let canonical: string;
		try {
			canonical = realpathSync(path);
		} catch {
			continue;
		}
		if (boundary && !inside(canonical, boundary)) continue;
		const content = readFileSync(canonical, "utf8");
		const parsed = parseFrontmatter<Raw>(content);
		if (
			typeof parsed.frontmatter.name !== "string" ||
			typeof parsed.frontmatter.description !== "string"
		)
			continue;
		const rawReasoning = parsed.frontmatter.reasoning;
		const parsedTools = tools(parsed.frontmatter.tools);
		values.push({
			qualifiedName: `${source}:${parsed.frontmatter.name}`,
			name: parsed.frontmatter.name,
			description: parsed.frontmatter.description,
			source,
			filePath: canonical,
			hash: createHash("sha256").update(content).digest("hex"),
			instructions: parsed.body,
			...(typeof parsed.frontmatter.model === "string"
				? { model: parsed.frontmatter.model }
				: {}),
			...(typeof rawReasoning === "string" && levels.has(rawReasoning)
				? { reasoning: rawReasoning as ReasoningLevel }
				: {}),
			...(parsedTools ? { tools: parsedTools } : {}),
		});
	}
	return values;
}
function projectRoot(cwd: string): string {
	let current = realpathSync(cwd);
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return realpathSync(cwd);
		current = parent;
	}
}
function nearestProjectAgents(cwd: string, root: string): string | undefined {
	let current = realpathSync(cwd);
	while (inside(current, root)) {
		const candidate = join(current, CONFIG_DIR_NAME, "agents");
		if (existsSync(candidate)) return candidate;
		if (current === root) break;
		current = dirname(current);
	}
	return undefined;
}

export function discoverProfiles(
	agentDir: string,
	cwd: string,
	trustedProject: boolean,
): ProfileSnapshot[] {
	const result = load(join(agentDir, "agents"), "user");
	if (trustedProject) {
		const root = projectRoot(cwd);
		const dir = nearestProjectAgents(cwd, root);
		if (dir) result.push(...load(dir, "project", root));
	}
	return result;
}

export function resolveProfile(
	profiles: ProfileSnapshot[],
	name: string | undefined,
): ProfileSnapshot | undefined {
	if (!name) return undefined;
	if (name.includes(":")) {
		const found = profiles.find((profile) => profile.qualifiedName === name);
		if (!found)
			throw new ContractError(
				"profile_not_found",
				`Profile ${name} was not found`,
			);
		return found;
	}
	const matches = profiles.filter((profile) => profile.name === name);
	if (matches.length === 0)
		throw new ContractError(
			"profile_not_found",
			`Profile ${name} was not found`,
		);
	if (matches.length > 1)
		throw new ContractError(
			"ambiguous_profile",
			`Profile ${name} exists in user and project scope; use user:${name} or project:${name}`,
		);
	return matches[0];
}
