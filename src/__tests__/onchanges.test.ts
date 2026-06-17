import { describe, expect, it, vi } from 'vitest';
import { defineComponent, defineTag } from '../define.js';
import { tickWorld } from '../tick.js';
import type { DeliveredChanges } from '../types.js';
import { createWorld } from '../world.js';

const Position = defineComponent('Position', { x: 0, y: 0 });
const Tombstoned = defineTag('Tombstoned');
const REMOTE = Symbol('remote');

describe('onChanges — delivered change detection (RFC-006)', () => {
	it('delivers one run per tick in the common single-origin case, with values', () => {
		const world = createWorld();
		const runs: DeliveredChanges[] = [];
		world.onChanges((c) => runs.push(c));

		const e = world.createEntity();
		world.addComponent(e, Position, { x: 5, y: 6 });
		expect(runs).toHaveLength(0); // nothing delivered until the tick advances

		tickWorld(world);
		expect(runs).toHaveLength(1);
		expect(runs[0].origin).toBeUndefined();
		expect(runs[0].created.has(e)).toBe(true);
		expect(runs[0].added(Position).get(e)).toEqual({ x: 5, y: 6 });
		expect(runs[0].tick).toBe(0);
	});

	it('carries prev/next on change and the dying value on remove', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Position, { x: 1, y: 2 });
		tickWorld(world);

		const runs: DeliveredChanges[] = [];
		world.onChanges((c) => runs.push(c));
		world.patchComponent(e, Position, { x: 9 });
		tickWorld(world);
		expect(runs[0].changed(Position).get(e)).toEqual({
			prev: { x: 1, y: 2 },
			next: { x: 9, y: 2 },
		});

		runs.length = 0;
		world.removeComponent(e, Position);
		tickWorld(world);
		expect(runs[0].removed(Position).get(e)).toEqual({ x: 9, y: 2 });
	});

	it('attributes an origin via withOrigin', () => {
		const world = createWorld();
		const runs: DeliveredChanges[] = [];
		world.onChanges((c) => runs.push(c));

		// A remote apply does all its work under one origin → one homogeneous run.
		world.withOrigin(REMOTE, () => {
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1 });
		});
		tickWorld(world);
		expect(runs).toHaveLength(1);
		expect(runs[0].origin).toBe(REMOTE);
	});

	it('splits a mixed-origin tick into contiguous same-origin runs, in capture order', () => {
		const world = createWorld();
		const a = world.createEntity();
		const b = world.createEntity();
		const c = world.createEntity();
		world.addComponent(a, Position);
		world.addComponent(b, Position);
		world.addComponent(c, Position);
		tickWorld(world);

		const runs: DeliveredChanges[] = [];
		world.onChanges((d) => runs.push(d));
		tickWorld(world, (w) => {
			w.patchComponent(a, Position, { x: 1 }); // local
			w.withOrigin(REMOTE, () => w.patchComponent(b, Position, { x: 2 })); // remote
			w.patchComponent(c, Position, { x: 3 }); // local again
		});

		expect(runs.map((r) => r.origin)).toEqual([undefined, REMOTE, undefined]);
		expect([...runs[0].changed(Position).keys()]).toEqual([a]);
		expect([...runs[1].changed(Position).keys()]).toEqual([b]);
		expect([...runs[2].changed(Position).keys()]).toEqual([c]);
	});

	it('freezes next at SEAL time — a later run never leaks back into an earlier one', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Position, { x: 0 });
		tickWorld(world);

		const runs: DeliveredChanges[] = [];
		world.onChanges((d) => runs.push(d));
		tickWorld(world, (w) => {
			w.patchComponent(e, Position, { x: 10 }); // local run
			w.withOrigin(REMOTE, () => w.patchComponent(e, Position, { x: 99 })); // remote run, same entity
		});

		// The local run carries the value AT THE SEAL boundary (10), not 99.
		expect(runs[0].origin).toBeUndefined();
		expect(runs[0].changed(Position).get(e)).toEqual({
			prev: { x: 0, y: 0 },
			next: { x: 10, y: 0 },
		});
		// The remote run continues from there.
		expect(runs[1].origin).toBe(REMOTE);
		expect(runs[1].changed(Position).get(e)).toEqual({
			prev: { x: 10, y: 0 },
			next: { x: 99, y: 0 },
		});
	});

	it('collapses a destroy + dying components into one run', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Position, { x: 7, y: 8 });
		world.addTag(e, Tombstoned);
		tickWorld(world);

		const runs: DeliveredChanges[] = [];
		world.onChanges((d) => runs.push(d));
		world.destroyEntity(e);
		tickWorld(world);

		expect(runs).toHaveLength(1);
		expect(runs[0].destroyed.has(e)).toBe(true);
		expect(runs[0].removed(Position).get(e)).toEqual({ x: 7, y: 8 });
		expect(runs[0].removedTag(Tombstoned).has(e)).toBe(true);
	});

	it('does not deliver empty runs', () => {
		const world = createWorld();
		const handler = vi.fn();
		world.onChanges(handler);
		tickWorld(world); // nothing changed
		expect(handler).not.toHaveBeenCalled();
	});

	it('delivers to every handler even if one throws, then rethrows after the frame advances', () => {
		const world = createWorld();
		const seen: DeliveredChanges[] = [];
		world.onChanges(() => {
			throw new Error('boom');
		});
		world.onChanges((c) => seen.push(c));

		const e = world.createEntity();
		world.addComponent(e, Position, { x: 1 });
		expect(() => tickWorld(world)).toThrow('boom');
		expect(seen).toHaveLength(1); // the second handler still received the run
		expect(world.currentTick).toBe(1); // the frame advanced despite the throw
	});

	it('aggregates multiple handler errors into an AggregateError', () => {
		const world = createWorld();
		world.onChanges(() => {
			throw new Error('one');
		});
		world.onChanges(() => {
			throw new Error('two');
		});
		const e = world.createEntity();
		world.addComponent(e, Position, { x: 1 });
		expect(() => tickWorld(world)).toThrow(AggregateError);
		expect(world.currentTick).toBe(1);
	});

	it('does not nest delivery — a handler mutation is delivered on the NEXT tick', () => {
		const world = createWorld();
		const a = world.createEntity();
		const b = world.createEntity();
		const runs: DeliveredChanges[] = [];
		world.onChanges((c) => {
			runs.push(c);
			if (runs.length === 1) world.addComponent(b, Position, { x: 2 }); // mutate during delivery
		});

		world.addComponent(a, Position, { x: 1 });
		tickWorld(world);
		expect(runs).toHaveLength(1);
		expect(runs[0].added(Position).has(a)).toBe(true);
		expect(runs[0].added(Position).has(b)).toBe(false); // b NOT in the in-flight run

		tickWorld(world);
		expect(runs).toHaveLength(2);
		expect(runs[1].added(Position).has(b)).toBe(true); // delivered next tick
	});

	it('rejects tickWorld() called from inside delivery', () => {
		const world = createWorld();
		world.onChanges(() => tickWorld(world));
		const e = world.createEntity();
		world.addComponent(e, Position, { x: 1 });
		expect(() => tickWorld(world)).toThrow(/onChanges delivery/);
	});

	it('stops delivering after unsubscribe', () => {
		const world = createWorld();
		const handler = vi.fn();
		const off = world.onChanges(handler);
		const e = world.createEntity();
		world.addComponent(e, Position, { x: 1 });
		tickWorld(world);
		expect(handler).toHaveBeenCalledTimes(1);

		off();
		world.addComponent(e, Position, { x: 2 });
		tickWorld(world);
		expect(handler).toHaveBeenCalledTimes(1); // no further deliveries
	});
});
