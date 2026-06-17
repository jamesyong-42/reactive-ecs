// React bindings for reactive-ecs — `useSyncExternalStore` hooks over the world's
// synchronous events. Freeze-on-write (RFC-007) is what makes these correct: a
// stored value keeps a stable identity until it is replaced, so `getSnapshot`
// returns the same reference between writes and React never re-renders spuriously.
//
// The hooks are thin wrappers over framework-agnostic store adapters
// (`createComponentStore` etc., each `{ subscribe, getSnapshot }`) — usable from
// any framework with an external-store primitive, and unit-testable without a DOM.
//
// React is an optional peer dependency; import from `@jamesyong42/reactive-ecs/react`
// only in a React app.

import { useMemo, useSyncExternalStore } from 'react';
import type {
	ComponentType,
	EntityId,
	NotTerm,
	ResourceType,
	TagType,
	Unsubscribe,
	World,
} from '../types.js';

/** The `useSyncExternalStore` contract: a subscribe fn and a stable-identity snapshot. */
export interface ExternalStore<T> {
	subscribe(onChange: () => void): Unsubscribe;
	getSnapshot(): T;
}

// === Framework-agnostic store adapters ===

/**
 * A store over one entity's component value. Fires on write (`addComponent` /
 * `updateComponent`) and removal; `getSnapshot` returns the live frozen value
 * (stable identity until replaced) or `undefined` while absent.
 */
export function createComponentStore<T>(
	world: World,
	entity: EntityId,
	type: ComponentType<T>,
): ExternalStore<Readonly<T> | undefined> {
	return {
		subscribe(onChange) {
			const offChanged = world.onComponentChanged(type, onChange, entity);
			const offRemoved = world.onComponentRemoved(type, onChange, entity);
			return () => {
				offChanged();
				offRemoved();
			};
		},
		getSnapshot: () => world.getComponent(entity, type),
	};
}

/**
 * A store over a singleton resource. Fires on `setResource` / `updateResource`;
 * `getSnapshot` returns the live frozen value (stable until replaced). Lazily
 * creates the resource from its defaults, like `getResource`.
 */
export function createResourceStore<T>(
	world: World,
	type: ResourceType<T>,
): ExternalStore<Readonly<T>> {
	return {
		subscribe: (onChange) => world.onResourceChanged(type, onChange),
		getSnapshot: () => world.getResource(type),
	};
}

type QueryTerm = ComponentType | TagType | NotTerm;

/** Stable signature string for a query's terms — order-insensitive, like `query`. */
export function queryKey(terms: QueryTerm[]): string {
	return terms
		.map((t) =>
			t.__kind === 'not'
				? `!${t.type.__kind === 'component' ? 'c' : 't'}:${t.type.name}`
				: `${t.__kind === 'component' ? 'c' : 't'}:${t.name}`,
		)
		.sort()
		.join('\0');
}

/** Order-insensitive membership equality — a query result is a set, not a sequence. */
function sameMembers(a: readonly EntityId[], b: readonly EntityId[]): boolean {
	if (a.length !== b.length) return false;
	const seen = new Set(a);
	for (const id of b) if (!seen.has(id)) return false;
	return true;
}

/**
 * A store over a live query. Fires when a queried component/tag is added or
 * removed, or an entity is destroyed. `getSnapshot` returns the matching entity
 * set; its reference is stable while membership is unchanged, so a value-only
 * change to a matched component does NOT churn the snapshot. The array is
 * membership, not a stable ordering.
 */
export function createQueryStore(world: World, terms: QueryTerm[]): ExternalStore<EntityId[]> {
	let cache: EntityId[] = [];
	let primed = false;
	return {
		subscribe(onChange) {
			const unsubs: Unsubscribe[] = [];
			for (const t of terms) {
				const target = t.__kind === 'not' ? t.type : t;
				if (target.__kind === 'component') {
					// onComponentChanged fires on attach too — the "added or changed"
					// signal; value-only changes are filtered by the membership compare.
					unsubs.push(world.onComponentChanged(target, onChange));
					unsubs.push(world.onComponentRemoved(target, onChange));
				} else {
					unsubs.push(world.onTagAdded(target, onChange));
					unsubs.push(world.onTagRemoved(target, onChange));
				}
			}
			unsubs.push(world.onEntityDestroyed(onChange)); // a destroyed entity drops out
			return () => {
				for (const u of unsubs) u();
			};
		},
		getSnapshot() {
			const next = world.query(...terms);
			if (primed && sameMembers(cache, next)) return cache; // stable identity
			cache = next;
			primed = true;
			return cache;
		},
	};
}

// === React hooks ===

/**
 * Subscribe to a single entity's component. Re-renders when it is written or
 * removed, and only then. Returns `undefined` while the entity lacks it.
 */
export function useComponent<T>(
	world: World,
	entity: EntityId,
	type: ComponentType<T>,
): Readonly<T> | undefined {
	const store = useMemo(() => createComponentStore(world, entity, type), [world, entity, type]);
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Subscribe to a singleton resource. Re-renders on `setResource` / `updateResource`. */
export function useResource<T>(world: World, type: ResourceType<T>): Readonly<T> {
	const store = useMemo(() => createResourceStore(world, type), [world, type]);
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Subscribe to a live query. Re-renders only when the matching entity SET changes
 * — not when a matched component's value merely changes. The returned array's
 * reference is stable while the set is unchanged (safe as a hook dependency).
 *
 *   const moving = useQuery(world, Position, Velocity, Not(Frozen));
 */
export function useQuery(world: World, ...terms: QueryTerm[]): readonly EntityId[] {
	const key = queryKey(terms);
	// Keyed on world + the order-insensitive signature: the store captures this
	// render's `terms`, sound because `key` changes iff the query does.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `terms` is captured via the stable `key`
	const store = useMemo(() => createQueryStore(world, terms), [world, key]);
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
