/**
 * Research availability as a pure state machine. Every Pi hook, availability
 * check result, and failed tool call becomes an event; the reducer returns the
 * next state plus the side effects the extension must perform. Keeping the
 * rules here, free of timers and Pi objects, makes every transition directly
 * testable.
 *
 * Two counters keep late results from undoing newer decisions:
 * - `generation` changes on session start, explicit refresh, and shutdown.
 *   A tool call remembers the generation it started in, and its failure is
 *   ignored once the generation has moved on.
 * - `checkToken` changes whenever a check starts. Only the newest check may
 *   report a result.
 */

export type Availability =
	| { kind: "unchecked" }
	| { kind: "ready" }
	| { kind: "unavailable"; message: string };

export interface LifecycleState {
	generation: number;
	checkToken: number;
	registered: boolean;
	/** Generation in which the currently registered tool became valid. */
	registeredGeneration: number;
	availability: Availability;
	/**
	 * Set after a backend, access, or compatibility failure. Automatic checks
	 * then keep the tool off until the user runs an explicit refresh, so a
	 * persistent failure does not flap the tool on every turn.
	 */
	blocked: boolean;
	/**
	 * True when the extension (not the user) removed the tool from the active
	 * set. Only then may an automatic check turn it back on; a user's own
	 * deactivation is preserved.
	 */
	disabledByExtension: boolean;
	/** Suppresses repeating the same notice on every turn. */
	lastNotice: string | undefined;
	shutDown: boolean;
}

export type LifecycleEvent =
	| { type: "session_start" }
	| { type: "check_start"; explicit: boolean }
	| {
			type: "check_ready";
			token: number;
			generation: number;
			explicit: boolean;
	  }
	| {
			type: "check_unavailable";
			token: number;
			generation: number;
			message: string;
			block: boolean;
			invalidateAuth: boolean;
	  }
	| {
			type: "tool_unavailable";
			generation: number;
			message: string;
			block: boolean;
			invalidateAuth: boolean;
	  }
	| { type: "shutdown" };

export type LifecycleEffect =
	| { type: "register" }
	| { type: "enable" }
	| { type: "disable" }
	| { type: "notify"; message: string; level: "info" | "warning" }
	| { type: "invalidate_auth" }
	| { type: "invalidate_catalog" }
	| { type: "abort_check" }
	| { type: "run_check"; token: number; generation: number; explicit: boolean };

export interface Transition {
	state: LifecycleState;
	effects: LifecycleEffect[];
}

export const initialLifecycleState: LifecycleState = {
	generation: 0,
	checkToken: 0,
	registered: false,
	registeredGeneration: 0,
	availability: { kind: "unchecked" },
	blocked: false,
	disabledByExtension: false,
	lastNotice: undefined,
	shutDown: false,
};

export function statusText(
	availability: Availability,
	blocked: boolean,
): string {
	if (availability.kind === "unavailable") {
		return `Research: ${availability.message}`;
	}
	if (blocked) {
		return "Research: unavailable after a backend authentication, access, or compatibility failure. Run /research refresh after resolving it.";
	}
	if (availability.kind === "ready") {
		return "Research: Ready (Pi Codex subscription); credentials and backend model access are verified.";
	}
	return "Research: authentication has not been checked yet.";
}

function notify(
	state: LifecycleState,
	effects: LifecycleEffect[],
	message: string,
	level: "info" | "warning",
): LifecycleState {
	if (state.lastNotice === message) return state;
	effects.push({ type: "notify", message, level });
	return { ...state, lastNotice: message };
}

function deactivate(
	state: LifecycleState,
	effects: LifecycleEffect[],
	message: string,
	block: boolean,
): LifecycleState {
	if (state.registered) effects.push({ type: "disable" });
	return notify(
		{
			...state,
			availability: { kind: "unavailable", message },
			disabledByExtension: true,
			blocked: state.blocked || block,
		},
		effects,
		message,
		"warning",
	);
}

function isStaleCheck(
	state: LifecycleState,
	event: { token: number; generation: number },
): boolean {
	return (
		state.shutDown ||
		event.token !== state.checkToken ||
		event.generation !== state.generation
	);
}

export function transition(
	state: LifecycleState,
	event: LifecycleEvent,
): Transition {
	const effects: LifecycleEffect[] = [];
	switch (event.type) {
		case "session_start": {
			const generation = state.generation + 1;
			return {
				state: {
					...state,
					generation,
					registeredGeneration: state.registered
						? generation
						: state.registeredGeneration,
					blocked: false,
				},
				effects,
			};
		}

		case "check_start": {
			if (state.shutDown) return { state, effects };
			const generation = state.generation + (event.explicit ? 1 : 0);
			const checkToken = state.checkToken + 1;
			effects.push({ type: "abort_check" });
			if (state.blocked && !event.explicit) {
				if (state.registered) effects.push({ type: "disable" });
				return { state: { ...state, checkToken }, effects };
			}
			if (event.explicit) {
				effects.push(
					{ type: "invalidate_auth" },
					{ type: "invalidate_catalog" },
				);
			}
			effects.push({
				type: "run_check",
				token: checkToken,
				generation,
				explicit: event.explicit,
			});
			return {
				state: {
					...state,
					generation,
					checkToken,
					...(event.explicit ? { blocked: false, lastNotice: undefined } : {}),
				},
				effects,
			};
		}

		case "check_ready": {
			if (isStaleCheck(state, event)) return { state, effects };
			let next: LifecycleState = { ...state, availability: { kind: "ready" } };
			if (!state.registered) {
				effects.push({ type: "register" }, { type: "enable" });
				next = {
					...next,
					registered: true,
					registeredGeneration: state.generation,
					disabledByExtension: false,
				};
			} else if (event.explicit || state.disabledByExtension) {
				effects.push({ type: "enable" });
				next = {
					...next,
					disabledByExtension: false,
					...(event.explicit ? { registeredGeneration: state.generation } : {}),
				};
			}
			if (event.explicit) {
				next = notify(
					next,
					effects,
					statusText(next.availability, false),
					"info",
				);
			}
			return { state: next, effects };
		}

		case "check_unavailable": {
			if (isStaleCheck(state, event)) return { state, effects };
			if (event.invalidateAuth) effects.push({ type: "invalidate_auth" });
			return {
				state: deactivate(state, effects, event.message, event.block),
				effects,
			};
		}

		case "tool_unavailable": {
			if (state.shutDown || event.generation !== state.generation)
				return { state, effects };
			if (event.invalidateAuth) effects.push({ type: "invalidate_auth" });
			return {
				state: deactivate(state, effects, event.message, event.block),
				effects,
			};
		}

		case "shutdown": {
			effects.push({ type: "abort_check" });
			return {
				state: {
					...state,
					generation: state.generation + 1,
					checkToken: state.checkToken + 1,
					shutDown: true,
				},
				effects,
			};
		}
	}
}
