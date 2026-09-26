import assert from "node:assert/strict";
import test from "node:test";
import {
	initialLifecycleState,
	type LifecycleEffect,
	type LifecycleEvent,
	type LifecycleState,
	statusText,
	transition,
} from "../src/lifecycle.ts";

const base: LifecycleState = {
	...initialLifecycleState,
	generation: 1,
	checkToken: 1,
};
const registered: LifecycleState = {
	...base,
	registered: true,
	registeredGeneration: 1,
	availability: { kind: "ready" },
};
const current = { token: 1, generation: 1 };
const unavailable = {
	type: "check_unavailable",
	...current,
	message: "down",
	block: false,
	invalidateAuth: false,
} as const;

interface Row {
	name: string;
	state: LifecycleState;
	event: LifecycleEvent;
	expect: Partial<LifecycleState>;
	effects: LifecycleEffect[];
}

const rows: Row[] = [
	{
		name: "session start bumps the generation, rebinds the tool, and unblocks",
		state: { ...registered, blocked: true },
		event: { type: "session_start" },
		expect: { generation: 2, registeredGeneration: 2, blocked: false },
		effects: [],
	},
	{
		name: "an automatic check supersedes the previous one and runs",
		state: base,
		event: { type: "check_start", explicit: false },
		expect: { generation: 1, checkToken: 2 },
		effects: [
			{ type: "abort_check" },
			{ type: "run_check", token: 2, generation: 1, explicit: false },
		],
	},
	{
		name: "an automatic check while blocked only keeps the tool off",
		state: { ...registered, blocked: true },
		event: { type: "check_start", explicit: false },
		expect: { checkToken: 2, blocked: true },
		effects: [{ type: "abort_check" }, { type: "disable" }],
	},
	{
		name: "an explicit refresh unblocks, forgets notices, and invalidates caches",
		state: { ...registered, blocked: true, lastNotice: "old" },
		event: { type: "check_start", explicit: true },
		expect: {
			generation: 2,
			checkToken: 2,
			blocked: false,
			lastNotice: undefined,
		},
		effects: [
			{ type: "abort_check" },
			{ type: "invalidate_auth" },
			{ type: "invalidate_catalog" },
			{ type: "run_check", token: 2, generation: 2, explicit: true },
		],
	},
	{
		name: "no check starts after shutdown",
		state: { ...base, shutDown: true },
		event: { type: "check_start", explicit: true },
		expect: { checkToken: 1 },
		effects: [],
	},
	{
		name: "the first ready result registers and enables the tool",
		state: base,
		event: { type: "check_ready", ...current, explicit: false },
		expect: {
			registered: true,
			registeredGeneration: 1,
			availability: { kind: "ready" },
		},
		effects: [{ type: "register" }, { type: "enable" }],
	},
	{
		name: "an automatic ready result preserves a user deactivation",
		state: registered,
		event: { type: "check_ready", ...current, explicit: false },
		expect: { disabledByExtension: false },
		effects: [],
	},
	{
		name: "an automatic ready result restores a tool the extension removed",
		state: { ...registered, disabledByExtension: true },
		event: { type: "check_ready", ...current, explicit: false },
		expect: { disabledByExtension: false },
		effects: [{ type: "enable" }],
	},
	{
		name: "an explicit ready result enables, rebinds, and reports status",
		state: { ...registered, registeredGeneration: 0 },
		event: { type: "check_ready", ...current, explicit: true },
		expect: { registeredGeneration: 1 },
		effects: [
			{ type: "enable" },
			{
				type: "notify",
				message: statusText({ kind: "ready" }, false),
				level: "info",
			},
		],
	},
	{
		name: "a superseded ready result is ignored",
		state: { ...base, checkToken: 2 },
		event: { type: "check_ready", ...current, explicit: false },
		expect: { registered: false },
		effects: [],
	},
	{
		name: "a ready result from an older generation is ignored",
		state: { ...base, generation: 2 },
		event: { type: "check_ready", ...current, explicit: false },
		expect: { registered: false },
		effects: [],
	},
	{
		name: "an unavailable result disables the tool and warns once",
		state: registered,
		event: unavailable,
		expect: {
			availability: { kind: "unavailable", message: "down" },
			disabledByExtension: true,
			blocked: false,
			lastNotice: "down",
		},
		effects: [
			{ type: "disable" },
			{ type: "notify", message: "down", level: "warning" },
		],
	},
	{
		name: "a repeated unavailable notice is suppressed",
		state: { ...registered, lastNotice: "down" },
		event: unavailable,
		expect: { disabledByExtension: true },
		effects: [{ type: "disable" }],
	},
	{
		name: "a blocking failure invalidates auth and blocks automatic checks",
		state: base,
		event: { ...unavailable, block: true, invalidateAuth: true },
		expect: { blocked: true },
		effects: [
			{ type: "invalidate_auth" },
			{ type: "notify", message: "down", level: "warning" },
		],
	},
	{
		name: "an unavailable result after shutdown is ignored",
		state: { ...registered, shutDown: true },
		event: unavailable,
		expect: { availability: { kind: "ready" } },
		effects: [],
	},
	{
		name: "a failed call from the current generation disables the tool",
		state: registered,
		event: {
			type: "tool_unavailable",
			generation: 1,
			message: "denied",
			block: true,
			invalidateAuth: false,
		},
		expect: { blocked: true, disabledByExtension: true },
		effects: [
			{ type: "disable" },
			{ type: "notify", message: "denied", level: "warning" },
		],
	},
	{
		name: "a failed call from before a refresh is ignored",
		state: { ...registered, generation: 2 },
		event: {
			type: "tool_unavailable",
			generation: 1,
			message: "denied",
			block: true,
			invalidateAuth: true,
		},
		expect: { blocked: false },
		effects: [],
	},
	{
		name: "shutdown invalidates every outstanding check and call",
		state: registered,
		event: { type: "shutdown" },
		expect: { generation: 2, checkToken: 2, shutDown: true },
		effects: [{ type: "abort_check" }],
	},
];

for (const row of rows) {
	test(row.name, () => {
		const before = structuredClone(row.state);
		const result = transition(row.state, row.event);
		assert.deepEqual(result.effects, row.effects);
		for (const [key, value] of Object.entries(row.expect)) {
			assert.deepEqual(
				result.state[key as keyof LifecycleState],
				value,
				`state.${key}`,
			);
		}
		assert.deepEqual(row.state, before, "the input state is not mutated");
	});
}

test("status text reflects availability and the refresh block", () => {
	assert.match(statusText({ kind: "unchecked" }, false), /not been checked/);
	assert.match(statusText({ kind: "ready" }, false), /Ready/);
	assert.match(statusText({ kind: "ready" }, true), /Run \/research refresh/);
	assert.equal(
		statusText({ kind: "unavailable", message: "down" }, true),
		"Research: down",
	);
});
