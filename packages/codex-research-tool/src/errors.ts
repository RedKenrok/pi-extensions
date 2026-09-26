export type ResearchErrorCode =
	| "auth_required"
	| "access_denied"
	| "rate_limited"
	| "timeout"
	| "cancelled"
	| "network"
	| "client_outdated"
	| "backend_incompatible"
	| "invalid_input";

export interface ModelOption {
	id: string;
	efforts: string[];
	defaultEffort?: string;
}

export class ResearchError extends Error {
	readonly code: ResearchErrorCode;
	readonly retryable: boolean;
	readonly retryAfterSeconds: number | undefined;
	readonly modelOptions: ModelOption[] | undefined;

	constructor(
		code: ResearchErrorCode,
		message: string,
		retryable: boolean,
		retryAfterSeconds?: number,
		modelOptions?: ModelOption[],
	) {
		super(message);
		this.name = "ResearchError";
		this.code = code;
		this.retryable = retryable;
		this.retryAfterSeconds = retryAfterSeconds;
		this.modelOptions = modelOptions;
	}
}

export const SIGN_IN_AGAIN =
	"Research needs you to sign in again. Run /login openai-codex, then /research refresh.";
export const SIGN_IN =
	"Research unavailable: sign in with /login openai-codex, then run /research refresh.";

/**
 * Default model-facing message and retry policy per error code. Call sites
 * pass their own message only when they add context the code cannot express
 * (for example which endpoint failed), so the same condition reads the same
 * way wherever it is detected.
 */
const ERRORS: Record<
	ResearchErrorCode,
	{ message: string; retryable: boolean }
> = {
	auth_required: { message: SIGN_IN_AGAIN, retryable: false },
	access_denied: {
		message:
			"The selected ChatGPT account does not currently allow Codex research. Run /research refresh after access is restored.",
		retryable: false,
	},
	rate_limited: {
		message:
			"Codex research is rate limited. Try again after the indicated cooldown.",
		retryable: true,
	},
	timeout: { message: "Research timed out.", retryable: true },
	cancelled: { message: "Research was cancelled.", retryable: false },
	network: {
		message: "Codex research could not reach the backend.",
		retryable: true,
	},
	client_outdated: {
		message:
			"Codex returned no research-capable models. This extension's Codex compatibility version may be outdated; update codex-research-tool and refresh research availability.",
		retryable: false,
	},
	backend_incompatible: {
		message: "Codex returned a response this extension does not understand.",
		retryable: false,
	},
	invalid_input: {
		message: "The research input is invalid.",
		retryable: false,
	},
};

export function researchError(
	code: ResearchErrorCode,
	message: string = ERRORS[code].message,
	options: {
		retryable?: boolean;
		retryAfterSeconds?: number | undefined;
		modelOptions?: ModelOption[];
	} = {},
): ResearchError {
	return new ResearchError(
		code,
		message,
		options.retryable ?? ERRORS[code].retryable,
		options.retryAfterSeconds,
		options.modelOptions,
	);
}

/**
 * Notices shown when an availability check or a failed call changes whether
 * the tool is offered. They tell the user what to do next, which the
 * model-facing error messages above do not need to.
 */
export const AVAILABILITY_MESSAGES: Record<ResearchErrorCode, string> = {
	auth_required: SIGN_IN_AGAIN,
	access_denied:
		"Research access was denied for this account. Run /research refresh after access is restored.",
	rate_limited:
		"Research availability is rate limited. Run /research refresh after the cooldown.",
	timeout:
		"Research could not verify Codex backend availability. Check the connection, then run /research refresh.",
	cancelled:
		"Research could not verify Codex backend availability. Check the connection, then run /research refresh.",
	network:
		"Research could not verify Codex backend availability. Check the connection, then run /research refresh.",
	client_outdated:
		"Research is unavailable because the Codex compatibility version may be outdated. Update codex-research-tool, then run /research refresh.",
	backend_incompatible:
		"Research is incompatible with the current Codex backend. Update codex-research-tool or Pi, then run /research refresh.",
	invalid_input:
		"Research is incompatible with the current Codex backend. Update codex-research-tool or Pi, then run /research refresh.",
};

// Codes that mean the tool cannot work for this account until something
// outside the extension changes, so offering it to the model would only
// produce repeated failures.
const DISABLING_CODES: ReadonlySet<ResearchErrorCode> = new Set([
	"auth_required",
	"access_denied",
	"client_outdated",
	"backend_incompatible",
]);

export function disablesTool(code: ResearchErrorCode): boolean {
	return DISABLING_CODES.has(code);
}
