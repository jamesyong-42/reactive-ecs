// Ownership enforcement (RFC-007): managed plain data crossing the API is frozen
// in place — immutable by construction, not by a defensive deep clone. This module
// is the single place that defines "managed plain data" and the freeze/merge
// mechanics; world.ts and define.ts both consume it.
//
// Scope: the guarantee covers MANAGED plain data only — arrays and objects whose
// prototype is Object.prototype or null, all of whose properties are data
// properties. Class instances, typed arrays, Map/Set/Date, functions, and Proxies
// are BORROWED: by reference, never frozen, the caller's to manage.

/**
 * Managed plain data = arrays, or objects whose prototype is `Object.prototype`
 * or `null`. The prototype test (not `constructor === Object`) is forgery-resistant
 * — `constructor` is a writable own/inherited property. Everything else (class
 * instances, typed arrays, Map/Set/Date, functions) is borrowed.
 */
export function isManagedPlain(v: unknown): v is Record<PropertyKey, unknown> {
	if (v === null || typeof v !== 'object') return false;
	if (Array.isArray(v)) return true;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

/**
 * Validate + collect every managed-plain node reachable through the plain spine,
 * in a three-colour DFS. `visiting` (grey) is the current recursion path and
 * detects genuine cycles; `done` (black) deduplicates shared DAG nodes so
 * `{ a: shared, b: shared }` is not mistaken for a cycle, and its insertion order
 * is the freeze order. Throws on a cycle or an accessor property — without
 * freezing anything, so the freeze pass that follows cannot throw for supported
 * input. Reads via `Reflect.ownKeys` + descriptors so symbol keys and
 * non-enumerable own data are covered and no getter is ever invoked.
 */
function collect(value: unknown, visiting: Set<object>, done: Set<object>): void {
	if (!isManagedPlain(value)) return; // primitive or borrowed — stop, don't descend
	const obj = value as object;
	if (done.has(obj)) return; // already validated via another parent (shared DAG)
	if (visiting.has(obj)) {
		throw new Error(
			'reactive-ecs: cannot freeze cyclic plain data (component/resource values must be acyclic)',
		);
	}
	visiting.add(obj);
	for (const key of Reflect.ownKeys(obj)) {
		const desc = Object.getOwnPropertyDescriptor(obj, key);
		if (desc === undefined) continue;
		if (!('value' in desc)) {
			throw new Error(
				'reactive-ecs: cannot freeze managed plain data with accessor properties (getters/setters) — ' +
					'component/resource values must be plain data',
			);
		}
		collect((obj as Record<PropertyKey, unknown>)[key], visiting, done);
	}
	visiting.delete(obj);
	done.add(obj);
}

/**
 * Deep-freeze managed plain data IN PLACE and return it (RFC-007). Two-pass:
 * validate/collect (may throw — cycle or accessor), then freeze, so invalid input
 * throws with nothing frozen. Borrowed values are left untouched. Cyclic input or
 * accessor properties throw a named error; a `Proxy` masquerading as plain is
 * unsupported (its traps run during traversal/freeze — undefined behavior).
 */
export function freezePlain<T>(value: T): T {
	const done = new Set<object>();
	collect(value, new Set<object>(), done); // may throw; freezes nothing
	for (const node of done) Object.freeze(node); // supported plain data: cannot throw
	return value;
}

/**
 * Read a merge input's own ENUMERABLE DATA properties (string + symbol) into
 * `out`. Accessors throw (never invoked — uniform with `freezePlain`);
 * non-enumerable own properties are ignored (a partial/defaults object is the
 * set of fields being assigned, enumerable by definition).
 */
function readEnumerableData(src: object, out: Record<PropertyKey, unknown>): void {
	for (const key of Reflect.ownKeys(src)) {
		const desc = Object.getOwnPropertyDescriptor(src, key);
		if (desc === undefined || !desc.enumerable) continue;
		if (!('value' in desc)) {
			throw new Error(
				'reactive-ecs: cannot read accessor property from a merge input (getters/setters) — ' +
					'component/resource data must be plain values',
			);
		}
		out[key] = desc.value;
	}
}

/**
 * Construct a fresh plain object = `base`'s own enumerable data properties, then
 * `override`'s on top (RFC-007 descriptor-aware merge — replaces bare spread).
 * Nested values are shared by reference (the caller freezes the result, which
 * makes the sharing safe). The returned top-level object is mutable until frozen.
 */
export function mergePlain<T>(base: T, override?: Partial<T>): T {
	const out: Record<PropertyKey, unknown> = {};
	readEnumerableData(base as object, out);
	if (override) readEnumerableData(override as object, out);
	return out as T;
}
