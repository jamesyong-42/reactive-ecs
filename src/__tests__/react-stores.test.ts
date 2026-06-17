import { describe, expect, it } from 'vitest';
import { defineComponent, defineResource, defineTag, Not } from '../define.js';
import {
	createComponentStore,
	createQueryStore,
	createResourceStore,
	queryKey,
} from '../react/index.js';
import { createWorld } from '../world.js';

// The React hooks are thin useSyncExternalStore wrappers over these framework-
// agnostic store adapters; testing the adapters covers the real subscribe/snapshot
// logic without a DOM renderer.

const Position = defineComponent('RPos', { x: 0, y: 0 });
const Velocity = defineComponent('RVel', { dx: 0, dy: 0 });
const Frozen = defineTag('RFrozen');
const Camera = defineResource('RCamera', { zoom: 1 });

describe('createComponentStore', () => {
	it('snapshot tracks the live frozen value with stable identity between value-equal reads', () => {
		const world = createWorld();
		const e = world.createEntity();
		const store = createComponentStore(world, e, Position);
		expect(store.getSnapshot()).toBeUndefined();

		let fires = 0;
		const unsub = store.subscribe(() => fires++);

		world.addComponent(e, Position, { x: 1 });
		expect(fires).toBe(1);
		const snap = store.getSnapshot();
		expect(snap).toEqual({ x: 1, y: 0 });
		expect(store.getSnapshot()).toBe(snap); // stable identity — no churn

		world.updateComponent(e, Position, (p) => ({ ...p, x: 2 }));
		expect(fires).toBe(2);
		expect(store.getSnapshot()).not.toBe(snap); // replaced → new frozen ref

		world.removeComponent(e, Position);
		expect(fires).toBe(3);
		expect(store.getSnapshot()).toBeUndefined();

		unsub();
		world.addComponent(e, Position, { x: 9 });
		expect(fires).toBe(3); // unsubscribed
	});

	it('no-op updateComponent does not fire', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Position);
		const store = createComponentStore(world, e, Position);
		let fires = 0;
		store.subscribe(() => fires++);
		world.updateComponent(e, Position, (p) => p); // identity → skip
		expect(fires).toBe(0);
	});
});

describe('createResourceStore', () => {
	it('snapshot tracks the resource, fires on write, stable identity otherwise', () => {
		const world = createWorld();
		const store = createResourceStore(world, Camera);
		const initial = store.getSnapshot();
		expect(initial).toEqual({ zoom: 1 });
		expect(store.getSnapshot()).toBe(initial); // stable

		let fires = 0;
		store.subscribe(() => fires++);
		world.updateResource(Camera, (c) => ({ ...c, zoom: 2 }));
		expect(fires).toBe(1);
		expect(store.getSnapshot()).toEqual({ zoom: 2 });
	});
});

describe('createQueryStore', () => {
	it('snapshot is the matching set; reference is stable until membership changes', () => {
		const world = createWorld();
		const e1 = world.createEntity();
		const e2 = world.createEntity();
		const store = createQueryStore(world, [Position, Velocity]);
		expect(store.getSnapshot()).toEqual([]);

		let fires = 0;
		store.subscribe(() => fires++);

		world.addComponent(e1, Position);
		world.addComponent(e1, Velocity); // now matches
		expect(fires).toBeGreaterThan(0);
		const snap = store.getSnapshot();
		expect([...snap]).toEqual([e1]);

		// A value-only change to a matched component must NOT churn the snapshot ref.
		world.updateComponent(e1, Position, (p) => ({ ...p, x: 5 }));
		expect(store.getSnapshot()).toBe(snap);

		// A new member changes membership → new reference.
		world.addComponent(e2, Position);
		world.addComponent(e2, Velocity);
		const snap2 = store.getSnapshot();
		expect(snap2).not.toBe(snap);
		expect([...snap2].sort()).toEqual([e1, e2].sort());

		// Destroying a member drops it.
		world.destroyEntity(e1);
		expect([...store.getSnapshot()]).toEqual([e2]);
	});

	it('respects Not() terms', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Position);
		const store = createQueryStore(world, [Position, Not(Frozen)]);
		expect([...store.getSnapshot()]).toEqual([e]);

		let fires = 0;
		store.subscribe(() => fires++);
		world.addTag(e, Frozen); // now excluded
		expect(fires).toBeGreaterThan(0);
		expect([...store.getSnapshot()]).toEqual([]);

		world.removeTag(e, Frozen); // re-admitted
		expect([...store.getSnapshot()]).toEqual([e]);
	});
});

describe('queryKey', () => {
	it('is order-insensitive and distinguishes components, tags, and Not()', () => {
		expect(queryKey([Position, Velocity])).toBe(queryKey([Velocity, Position]));
		expect(queryKey([Position, Not(Frozen)])).not.toBe(queryKey([Position, Frozen]));
	});
});
