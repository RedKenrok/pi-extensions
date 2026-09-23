import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { sanitize } from "./availability.ts";
import type { AgentAction, AgentState, NormalizedError } from "./types.ts";

const reasoning = StringEnum([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const);
const model = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		id: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
const limits = Type.Object(
	{
		runtimeSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{
		additionalProperties: false,
		description:
			"Wall-clock runtime limit in seconds. Defaults to 3600 seconds (one hour).",
	},
);
const commonAgentId = { agentId: Type.String({ minLength: 4 }) };
const agentIds = Type.Array(Type.String({ minLength: 4, maxLength: 256 }), {
	minItems: 1,
	maxItems: 8,
});
const optionalAgentIds = Type.Array(
	Type.String({ minLength: 4, maxLength: 256 }),
	{ maxItems: 8 },
);
const idleId = Type.String({ minLength: 6, maxLength: 256 });
const idleUntil = StringEnum([
	"all_settled",
	"any_settled",
	"all_succeeded",
	"first_failure",
	"quorum",
] as const);

export const agentParameters = Type.Union([
	Type.Object(
		{
			action: Type.Literal("catalog"),
			provider: Type.Optional(Type.String()),
			cursor: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("spawn"),
			prompt: Type.String({ minLength: 1, maxLength: 32768 }),
			model,
			name: Type.Optional(Type.String({ maxLength: 128 })),
			profile: Type.Optional(Type.String({ maxLength: 256 })),
			instructions: Type.Optional(Type.String({ maxLength: 32768 })),
			reasoning: Type.Optional(reasoning),
			tools: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
			cwd: Type.Optional(Type.String({ maxLength: 4096 })),
			workspace: Type.Optional(
				Type.Union([
					StringEnum(["shared", "worktree"] as const),
					Type.Object(
						{
							mode: StringEnum(["shared", "worktree"] as const),
							path: Type.Optional(Type.String({ maxLength: 4096 })),
						},
						{ additionalProperties: false },
					),
				]),
			),
			context: Type.Optional(Type.String({ maxLength: 32768 })),
			recovery: Type.Optional(
				StringEnum(["manual", "when_available"] as const),
			),
			blockedPolicy: Type.Optional(StringEnum(["reject", "enqueue"] as const)),
			limits: Type.Optional(limits),
			requestId: Type.Optional(Type.String({ maxLength: 256 })),
		},
		{
			additionalProperties: false,
			description:
				"Start a background agent and return immediately. Continue independent work or end the parent turn; completion is delivered automatically without polling or an idle call.",
		},
	),
	Type.Object(
		{
			action: Type.Literal("list"),
			state: Type.Optional(
				StringEnum([
					"queued",
					"running",
					"pausing",
					"paused",
					"blocked",
					"recovering",
					"completed",
					"failed",
					"stopping",
					"stopped",
				] as const),
			),
			cursor: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("inspect"),
			...commonAgentId,
			afterEventId: Type.Optional(Type.Integer({ minimum: 0 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("inspect_many"),
			agentIds,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("wait"),
			agentIds,
			afterEventId: Type.Optional(Type.Integer({ minimum: 0 })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })),
		},
		{
			additionalProperties: false,
			description:
				"One brief synchronous observation while other parent work remains. Do not poll repeatedly; completion is delivered automatically.",
		},
	),
	Type.Object(
		{
			action: Type.Literal("idle"),
			agentIds,
			until: Type.Optional(idleUntil),
			quorum: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
			activityPolicy: Type.Optional(
				StringEnum(["keep", "cancel", "notify_only"] as const),
			),
			disconnectPolicy: Type.Optional(
				StringEnum(["defer", "continue_headless"] as const),
			),
			requestId: Type.Optional(Type.String({ maxLength: 256 })),
		},
		{
			additionalProperties: false,
			description:
				"Join a specific agent group under a completion condition and coalesce its notifications. Use only as the final action when group aggregation, quorum, fail-fast, or headless continuation is needed; ordinary completions resume the parent automatically.",
		},
	),
	Type.Object(
		{
			action: Type.Literal("idle_list"),
			state: Type.Optional(
				StringEnum(["pending", "resolved", "cancelled"] as const),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("idle_inspect"), idleId },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("idle_update"),
			idleId,
			addAgentIds: Type.Optional(optionalAgentIds),
			removeAgentIds: Type.Optional(optionalAgentIds),
			requestId: Type.Optional(Type.String({ maxLength: 256 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("idle_cancel"),
			idleId,
			requestId: Type.Optional(Type.String({ maxLength: 256 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("message"),
			...commonAgentId,
			text: Type.String({ minLength: 1, maxLength: 32768 }),
			delivery: StringEnum(["steer", "followUp"] as const),
			requestId: Type.Optional(Type.String({ maxLength: 256 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("pause"),
			...commonAgentId,
			mode: Type.Optional(StringEnum(["graceful", "interrupt"] as const)),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("resume"),
			...commonAgentId,
			prompt: Type.Optional(Type.String({ maxLength: 32768 })),
			model: Type.Optional(model),
			reasoning: Type.Optional(reasoning),
			requestId: Type.Optional(Type.String({ maxLength: 256 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("stop"),
			...commonAgentId,
			reason: Type.Optional(Type.String({ maxLength: 2048 })),
		},
		{
			additionalProperties: false,
			description:
				"Cancel an agent whose result is no longer wanted. This is not a waiting mechanism; in-flight work may finish before cancellation settles.",
		},
	),
]);

const allowedKeys: Record<AgentAction["action"], Set<string>> = {
	catalog: new Set(["action", "provider", "cursor"]),
	spawn: new Set([
		"action",
		"prompt",
		"name",
		"profile",
		"instructions",
		"model",
		"reasoning",
		"tools",
		"cwd",
		"workspace",
		"context",
		"recovery",
		"limits",
		"blockedPolicy",
		"requestId",
	]),
	list: new Set(["action", "state", "cursor"]),
	inspect: new Set(["action", "agentId", "afterEventId"]),
	inspect_many: new Set(["action", "agentIds"]),
	wait: new Set(["action", "agentIds", "afterEventId", "timeoutMs"]),
	idle: new Set([
		"action",
		"agentIds",
		"until",
		"quorum",
		"activityPolicy",
		"disconnectPolicy",
		"requestId",
	]),
	idle_list: new Set(["action", "state"]),
	idle_inspect: new Set(["action", "idleId"]),
	idle_update: new Set([
		"action",
		"idleId",
		"addAgentIds",
		"removeAgentIds",
		"requestId",
	]),
	idle_cancel: new Set(["action", "idleId", "requestId"]),
	message: new Set(["action", "agentId", "text", "delivery", "requestId"]),
	pause: new Set(["action", "agentId", "mode"]),
	resume: new Set([
		"action",
		"agentId",
		"prompt",
		"model",
		"reasoning",
		"requestId",
	]),
	stop: new Set(["action", "agentId", "reason"]),
};
const actions = new Set(Object.keys(allowedKeys));
const states = new Set([
	"queued",
	"running",
	"pausing",
	"paused",
	"blocked",
	"recovering",
	"completed",
	"failed",
	"stopping",
	"stopped",
]);
const reasoningLevels = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export class ContractError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.code = code;
		this.retryable = retryable;
	}
}

function text(
	value: unknown,
	field: string,
	required = false,
	max = 32768,
): void {
	if (value === undefined && !required) return;
	if (
		typeof value !== "string" ||
		(required && value.length === 0) ||
		Buffer.byteLength(value, "utf8") > max
	) {
		throw new ContractError(
			"invalid_request",
			`${field} must be ${required ? "a non-empty " : "a "}string of at most ${max} bytes`,
		);
	}
}

export function validateAction(value: unknown): asserts value is AgentAction {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ContractError("invalid_request", "Arguments must be an object");
	const object = value as Record<string, unknown>;
	if (typeof object.action !== "string" || !actions.has(object.action))
		throw new ContractError("invalid_action", "Unknown agent action");
	const action = object.action as AgentAction["action"];
	const unknown = Object.keys(object).filter(
		(key) => !allowedKeys[action].has(key),
	);
	if (unknown.length)
		throw new ContractError(
			"invalid_request",
			`Unknown field(s): ${unknown.join(", ")}`,
		);
	if (action === "spawn") {
		text(object.prompt, "prompt", true);
		text(object.instructions, "instructions");
		text(object.context, "context");
		if (
			!object.model ||
			typeof object.model !== "object" ||
			Array.isArray(object.model)
		)
			throw new ContractError("model_required", "spawn.model is required");
		const selectedModel = object.model as Record<string, unknown>;
		text(selectedModel.provider, "model.provider", true, 256);
		text(selectedModel.id, "model.id", true, 256);
		if (
			Object.keys(selectedModel).some(
				(key) => !["provider", "id"].includes(key),
			)
		)
			throw new ContractError(
				"invalid_request",
				"model accepts only provider and id",
			);
		if (
			object.blockedPolicy !== undefined &&
			!["reject", "enqueue"].includes(String(object.blockedPolicy))
		)
			throw new ContractError(
				"invalid_request",
				"blockedPolicy must be reject or enqueue",
			);
		if (object.limits !== undefined) {
			if (
				!object.limits ||
				typeof object.limits !== "object" ||
				Array.isArray(object.limits)
			)
				throw new ContractError("invalid_request", "limits must be an object");
			const spawnLimits = object.limits as Record<string, unknown>;
			const unknownLimits = Object.keys(spawnLimits).filter(
				(key) => key !== "runtimeSeconds",
			);
			if (unknownLimits.length)
				throw new ContractError(
					"invalid_request",
					`Unknown limit field(s): ${unknownLimits.join(", ")}`,
				);
			if (
				spawnLimits.runtimeSeconds !== undefined &&
				(!Number.isInteger(spawnLimits.runtimeSeconds) ||
					Number(spawnLimits.runtimeSeconds) < 1)
			)
				throw new ContractError(
					"invalid_request",
					"limits.runtimeSeconds must be a positive integer number of seconds",
				);
		}
		const bytes = Buffer.byteLength(JSON.stringify(object), "utf8");
		if (bytes > 131072)
			throw new ContractError(
				"payload_too_large",
				"Spawn payload exceeds 128 KiB",
			);
	}
	if (["inspect", "message", "pause", "resume", "stop"].includes(action))
		text(object.agentId, "agentId", true, 256);
	if (["idle_inspect", "idle_update", "idle_cancel"].includes(action))
		text(object.idleId, "idleId", true, 256);
	if (action === "message") {
		text(object.text, "text", true);
		if (!new Set(["steer", "followUp"]).has(String(object.delivery)))
			throw new ContractError(
				"invalid_request",
				"delivery must be steer or followUp",
			);
	}
	if (["wait", "idle", "inspect_many"].includes(action)) {
		if (
			!Array.isArray(object.agentIds) ||
			object.agentIds.length < 1 ||
			object.agentIds.length > 8 ||
			object.agentIds.some(
				(id) =>
					typeof id !== "string" ||
					id.length < 4 ||
					Buffer.byteLength(id, "utf8") > 256,
			)
		)
			throw new ContractError(
				"invalid_request",
				"agentIds must contain 1–8 IDs of 4–256 bytes",
			);
		if (new Set(object.agentIds as string[]).size !== object.agentIds.length)
			throw new ContractError(
				"invalid_request",
				"agentIds must not contain duplicates",
			);
	}
	if (action === "wait") {
		if (
			object.timeoutMs !== undefined &&
			(!Number.isInteger(object.timeoutMs) ||
				Number(object.timeoutMs) < 0 ||
				Number(object.timeoutMs) > 60000)
		)
			throw new ContractError("invalid_request", "timeoutMs must be 0–60000");
	}
	if (action === "idle") {
		text(object.requestId, "requestId", false, 256);
		const until = object.until ?? "all_settled";
		if (
			![
				"all_settled",
				"any_settled",
				"all_succeeded",
				"first_failure",
				"quorum",
			].includes(String(until))
		)
			throw new ContractError(
				"invalid_request",
				"unsupported idle completion policy",
			);
		if (
			until === "quorum" &&
			(!Number.isInteger(object.quorum) ||
				Number(object.quorum) < 1 ||
				Number(object.quorum) > (object.agentIds as string[]).length)
		)
			throw new ContractError(
				"invalid_request",
				"quorum must be between 1 and the number of agents",
			);
		if (until !== "quorum" && object.quorum !== undefined)
			throw new ContractError(
				"invalid_request",
				"quorum is only valid with until=quorum",
			);
	}
	if (action === "idle_update") {
		text(object.requestId, "requestId", false, 256);
		const add = object.addAgentIds;
		const remove = object.removeAgentIds;
		if (
			(!Array.isArray(add) || add.length === 0) &&
			(!Array.isArray(remove) || remove.length === 0)
		)
			throw new ContractError(
				"invalid_request",
				"idle_update requires addAgentIds or removeAgentIds",
			);
		for (const [name, values] of [
			["addAgentIds", add],
			["removeAgentIds", remove],
		] as const) {
			if (values === undefined) continue;
			if (
				!Array.isArray(values) ||
				values.length > 8 ||
				values.some(
					(id) =>
						typeof id !== "string" ||
						id.length < 4 ||
						Buffer.byteLength(id, "utf8") > 256,
				) ||
				new Set(values).size !== values.length
			)
				throw new ContractError(
					"invalid_request",
					`${name} must contain unique IDs of 4–256 bytes`,
				);
		}
		if (
			Array.isArray(add) &&
			Array.isArray(remove) &&
			add.some((id) => remove.includes(id))
		)
			throw new ContractError(
				"invalid_request",
				"an agent cannot be added and removed in the same update",
			);
	}
	if (action === "idle_cancel") text(object.requestId, "requestId", false, 256);
	if (
		object.reasoning !== undefined &&
		!reasoningLevels.has(String(object.reasoning))
	)
		throw new ContractError(
			"unsupported_reasoning",
			`Unknown reasoning level: ${String(object.reasoning)}`,
		);
	if (
		action === "list" &&
		object.state !== undefined &&
		!states.has(String(object.state))
	)
		throw new ContractError(
			"invalid_request",
			`Unknown state: ${String(object.state)}`,
		);
	if (
		action === "idle_list" &&
		object.state !== undefined &&
		!new Set(["pending", "resolved", "cancelled"]).has(String(object.state))
	)
		throw new ContractError(
			"invalid_request",
			`Unknown idle state: ${String(object.state)}`,
		);
}

export function result(content: string, details: unknown, terminate = false) {
	return {
		content: [{ type: "text" as const, text: content }],
		details,
		...(terminate ? { terminate: true as const } : {}),
	};
}

export function errorResult(error: unknown, state?: AgentState) {
	const normalized: NormalizedError =
		error instanceof ContractError
			? { code: error.code, message: error.message, retryable: error.retryable }
			: {
					code: "internal_error",
					message: sanitize(
						error instanceof Error ? error.message : "Unexpected error",
					),
					retryable: false,
				};
	return result(
		`Error (${normalized.code}): ${normalized.message}${state ? ` Current state: ${state}.` : ""}`,
		{ error: normalized, state },
	);
}

export function parseCursor(cursor: string | undefined): number {
	if (!cursor) return 0;
	const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
	if (!Number.isSafeInteger(n) || n < 0)
		throw new ContractError("invalid_cursor", "Cursor is invalid");
	return n;
}
export function makeCursor(value: number): string {
	return Buffer.from(String(value)).toString("base64url");
}
