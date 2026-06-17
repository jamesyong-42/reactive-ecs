import { describe, expect, it, vi } from 'vitest';
import { defineComponent, defineResource } from '../define.js';
import { freezePlain, isManagedPlain, mergePlain } from '../freeze.js';
import { createWorld } from '../world.js';

// RFC-007 — Frozen by Construction. Validates the freeze-on-write ownership model
// and the functional update verbs against the real kernel.

describe('freezePlain — the two-pass deep freeze', () => {
	it('deep-freezes nested plain objects and arrays', () => {
		const v = { a: { b: 1 }, list: [{ x: 0 }] };
		freezePlain(v);
		expect(Object.isFrozen(v)).toBe(true);
		expect(Object.isFrozen(v.a)).toBe(true);
		expect(Object.isFrozen(v.list)).toBe(true);
		expect(Object.isFrozen(v.list[0])).toBe(true);
	});

	it('freezes a nested object behind a SYMBOL key (Reflect.ownKeys, not for...in)', () => {
		const s = Symbol('k');
		const v = { [s]: { x: 1 } } as Record<PropertyKey, { x: number }>;
		freezePlain(v);
		expect(Object.isFrozen(v[s])).toBe(true);
	});

	it('freezes a nested object behind a NON-ENUMERABLE own data property', () => {
		const hidden = { x: 1 };
		const v = {};
		Object.defineProperty(v, 'hidden', { value: hidden, enumerable: false });
		freezePlain(v);
		expect(Object.isFrozen(hidden)).toBe(true);
	});

	it('throws (named) on an accessor property, freezing nothing', () => {
		const v = {
			get computed() {
				return 1;
			},
		};
		expect(() => freezePlain(v)).toThrow(/accessor properties/);
		expect(Object.isFrozen(v)).toBe(false);
	});

	it('never invokes a getter during traversal', () => {
		const spy = vi.fn(() => ({ x: 1 }));
		const v = {
			get computed() {
				return spy();
			},
		};
		expect(() => freezePlain(v)).toThrow();
		expect(spy).not.toHaveBeenCalled();
	});

	it('throws (named) on a cycle and leaves the graph entirely un-frozen', () => {
		const a: Record<string, unknown> = { x: 1 };
		const b: Record<string, unknown> = { a };
		a.b = b; // a -> b -> a
		expect(() => freezePlain(a)).toThrow(/cyclic/);
		expect(Object.isFrozen(a)).toBe(false);
		expect(Object.isFrozen(b)).toBe(false);
	});

	it('a shared DAG is NOT a false cycle', () => {
		const shared = { x: 1 };
		const v = { a: shared, b: shared };
		expect(() => freezePlain(v)).not.toThrow();
		expect(Object.isFrozen(shared)).toBe(true);
		expect(v.a).toBe(v.b);
	});

	it('shallow-pre-frozen input is still deep-frozen (isFrozen is not trusted)', () => {
		const inner = { b: 1 };
		const v = { a: inner };
		Object.freeze(v); // top frozen, inner NOT
		expect(Object.isFrozen(inner)).toBe(false);
		freezePlain(v);
		expect(Object.isFrozen(inner)).toBe(true);
	});

	it('null-prototype dictionary is managed (frozen)', () => {
		const v = Object.create(null) as Record<string, unknown>;
		v.x = { y: 1 };
		freezePlain(v);
		expect(Object.isFrozen(v)).toBe(true);
		expect(Object.isFrozen(v.x)).toBe(true);
	});

	it('borrowed values are left untouched (class instance, typed array, Map, Date)', () => {
		class C {
			n = 1;
		}
		const inst = new C();
		const ta = new Float32Array([1, 2]);
		const map = new Map();
		const date = new Date(0);
		const v = { inst, ta, map, date };
		freezePlain(v);
		expect(Object.isFrozen(inst)).toBe(false);
		expect(Object.isFrozen(ta)).toBe(false);
		expect(Object.isFrozen(map)).toBe(false);
		expect(Object.isFrozen(date)).toBe(false);
	});

	it('a plain object inside a borrowed Map is NOT frozen (spine stops at borrowed)', () => {
		const inside = { x: 1 };
		const v = { m: new Map([['k', inside]]) };
		freezePlain(v);
		expect(Object.isFrozen(inside)).toBe(false);
	});

	it('isManagedPlain: arrays, plain objects, null-proto = true; everything else = false', () => {
		expect(isManagedPlain({})).toBe(true);
		expect(isManagedPlain([])).toBe(true);
		expect(isManagedPlain(Object.create(null))).toBe(true);
		expect(isManagedPlain(new Date())).toBe(false);
		expect(isManagedPlain(new Float32Array())).toBe(false);
		expect(isManagedPlain(() => {})).toBe(false);
		expect(isManagedPlain(5)).toBe(false);
		expect(isManagedPlain(null)).toBe(false);
	});
});

describe('mergePlain — descriptor-aware merge', () => {
	it('reads own enumerable data props of base then override', () => {
		expect(mergePlain({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
	});

	it('throws on an accessor in the merge input (getter never invoked)', () => {
		const spy = vi.fn(() => 1);
		const partial = {
			get x() {
				return spy();
			},
		};
		expect(() => mergePlain<{ x: number }>({ x: 0 }, partial)).toThrow(/accessor property/);
		expect(spy).not.toHaveBeenCalled();
	});

	it('ignores non-enumerable own top-level properties', () => {
		const partial: { a: number } = { a: 1 };
		Object.defineProperty(partial, 'hidden', { value: 9, enumerable: false });
		expect(mergePlain({ a: 0 }, partial)).toEqual({ a: 1 });
	});
});

describe('addComponent / setResource freeze-on-write', () => {
	it('freezes the stored value and the handed-over partial (invasive)', () => {
		const Box = defineComponent('FbcBox', { p: { x: 0 } });
		const world = createWorld();
		const e = world.createEntity();
		const partialNested = { x: 5 };
		world.addComponent(e, Box, { p: partialNested });
		expect(Object.isFrozen(partialNested)).toBe(true); // reachable from store → frozen
		expect(Object.isFrozen(world.getComponent(e, Box)?.p)).toBe(true);
	});

	it('class instance in component data stays borrowed (mutable, by reference)', () => {
		class Index {
			n = 0;
		}
		const Indexed = defineComponent('FbcIndexed', { idx: null as Index | null });
		const world = createWorld();
		const e = world.createEntity();
		const inst = new Index();
		world.addComponent(e, Indexed, { idx: inst });
		const read = world.getComponent(e, Indexed);
		expect(read?.idx).toBe(inst);
		if (read?.idx) read.idx.n = 7; // legal — borrowed
		expect(inst.n).toBe(7);
	});
});

describe('updateComponent', () => {
	const Pos = defineComponent('FbcPos', { x: 0, y: 0 });

	it('transforms via a recipe and freezes the result', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Pos);
		world.updateComponent(e, Pos, (p) => ({ ...p, x: p.x + 10 }));
		expect(world.getComponent(e, Pos)).toEqual({ x: 10, y: 0 });
		expect(Object.isFrozen(world.getComponent(e, Pos))).toBe(true);
	});

	it('is strict — throws on dead entity and on missing component', () => {
		const world = createWorld();
		const dead = world.createEntity();
		world.destroyEntity(dead);
		expect(() => world.updateComponent(dead, Pos, (p) => p)).toThrow(/does not exist/);
		const e = world.createEntity();
		expect(() => world.updateComponent(e, Pos, (p) => p)).toThrow(/has no FbcPos/);
	});

	it('returning prev by reference is a no-op — no event, no change record', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Pos);
		const seen: number[] = [];
		world.onComponentChanged(Pos, (id) => seen.push(id));
		world.updateComponent(e, Pos, (p) => p); // identity → skip
		expect(seen).toEqual([]);
		expect(world.changes().changed(Pos).size).toBe(0);
	});

	it('a recipe that mutates a plain field in place throws (prev is frozen)', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Pos);
		expect(() =>
			world.updateComponent(e, Pos, (p) => {
				(p as { x: number }).x = 5;
				return p;
			}),
		).toThrow(TypeError);
	});
});

describe('updateResource', () => {
	const Cam = defineResource('FbcCam', { zoom: 1 });

	it('transforms via recipe and freezes; returning prev is a no-op', () => {
		const world = createWorld();
		world.updateResource(Cam, (c) => ({ ...c, zoom: c.zoom * 2 }));
		expect(world.getResource(Cam).zoom).toBe(2);
		expect(Object.isFrozen(world.getResource(Cam))).toBe(true);

		const seen: unknown[] = [];
		world.onResourceChanged(Cam, () => seen.push(1));
		world.updateResource(Cam, (c) => c); // no-op
		expect(seen).toEqual([]);
	});
});

describe('atomicity — a throwing write changes nothing in the kernel', () => {
	const Box = defineComponent('AtomBox', { x: 0 });

	it('updateComponent: recipe throws → store + buffers + events unchanged', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Box, { x: 1 });
		const before = world.getComponent(e, Box);
		const seen: number[] = [];
		world.onComponentChanged(Box, (id) => seen.push(id));
		expect(() =>
			world.updateComponent(e, Box, () => {
				throw new Error('boom');
			}),
		).toThrow('boom');
		expect(world.getComponent(e, Box)).toBe(before); // same frozen reference
		expect(seen).toEqual([]);
		expect(world.changes().changed(Box).size).toBe(0);
	});

	it('addComponent: cyclic input throws → entity gains no component, no buffer entry', () => {
		const Cyc = defineComponent('AtomCyc', { ref: null as unknown });
		const world = createWorld();
		const e = world.createEntity();
		const a: Record<string, unknown> = {};
		a.self = a;
		expect(() => world.addComponent(e, Cyc, { ref: a })).toThrow(/cyclic/);
		expect(world.hasComponent(e, Cyc)).toBe(false);
		expect(world.changes().added(Cyc).size).toBe(0);
	});

	it('setResource: accessor input throws → resource unchanged, not marked changed', () => {
		const Cfg = defineResource('AtomCfg', { v: 0 });
		const world = createWorld();
		const before = world.getResource(Cfg); // frozen default; never written this window
		const partial = {
			get v() {
				return 2;
			},
		};
		expect(() => world.setResource(Cfg, partial)).toThrow(/accessor/);
		expect(world.getResource(Cfg)).toBe(before);
		expect(world.changes().changedResources().size).toBe(0); // never marked
	});

	it('the borrowed boundary: a recipe that mutates a borrowed field then throws is NOT rolled back', () => {
		class Vec {
			x = 0;
		}
		const Holder = defineComponent('AtomHolder', { vec: null as Vec | null });
		const world = createWorld();
		const e = world.createEntity();
		const vec = new Vec();
		world.addComponent(e, Holder, { vec });
		expect(() =>
			world.updateComponent(e, Holder, (p) => {
				(p.vec as Vec).x = 5; // borrowed in-place mutation — outside the guarantee
				throw new Error('boom');
			}),
		).toThrow('boom');
		expect(vec.x).toBe(5); // not rolled back — §Scope boundary
	});
});
