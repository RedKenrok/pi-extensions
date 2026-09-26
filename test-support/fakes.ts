// Remaining depth for each level; Pi's message types are recursive, so an
// unbounded DeepPartial exceeds the compiler's instantiation limit.
type Shallower = [never, 0, 1, 2, 3, 4];

// Functions stay whole: a fake method must match the real signature, so a
// renamed parameter type or changed return value fails type-checking. Below
// the depth limit a value must be supplied in full.
export type DeepPartial<T, Depth extends number = 4> = [Depth] extends [never]
	? T
	: T extends (...args: never[]) => unknown
		? T
		: T extends object
			? { [K in keyof T]?: DeepPartial<T[K], Shallower[Depth]> }
			: T;

/**
 * Builds a test double for a large Pi type from only the members the code under
 * test uses. Unlike `as unknown as T`, every member that is provided is checked
 * against the real type, so Pi API drift in those members fails `tsc` instead
 * of surfacing as a runtime error in the test.
 */
export function partialFake<T>(value: DeepPartial<T>): T {
	return value as T;
}
