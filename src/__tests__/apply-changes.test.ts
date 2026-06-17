import { describe, expect, it } from 'vitest';
import { applyChanges } from '../changes.js';
import { defineComponent, defineRelation, defineResource, defineTag } from '../define.js';
import { tickWorld } from '../tick.js';
import type { DeliveredChanges } from '../types.js';
import { createWorld } from '../world.js';

const Position = defineComponent('Position', { x: 0, y: 0 });
const ChildOf = defineRelation('ChildOf');
const Tombstoned = defineTag('Tombstoned');
const Camera = defineResource('Camera', { zoom: 1 });

/** Capture the next delivered run (single-origin tick). */
function capture(world: ReturnType<typeof createWorld>, fn: () => void): DeliveredChanges {
	let captured: DeliveredChanges | undefined;
	const off = world.onChanges((c) => {
		captured = c;
	});
	tickWorld(world, fn);
	off();
	if (!captured) throw new Error('nothing was delivered');
	return captured;
}

describe('applyChanges (RFC-006 /changes ground support)', () => {
	it('inverts a component change to restore the prior value, then redoes it', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Position, { x: 1, y: 2 });
		tickWorld(world);

		const change = capture(world, () =>
			world.updateComponent(e, Position, (p) => ({ ...p, x: 9 })),
		);
		expect(world.getComponent(e, Position)).toEqual({ x: 9, y: 2 });

		applyChanges(world, change, { invert: true }); // undo
		expect(world.getComponent(e, Position)).toEqual({ x: 1, y: 2 });

		applyChanges(world, change); // redo
		expect(world.getComponent(e, Position)).toEqual({ x: 9, y: 2 });
	});

	it('inverts an add (→ remove) and a remove (→ re-add with the dying value)', () => {
		const world = createWorld();
		const e = world.createEntity();

		const addC = capture(world, () => world.addComponent(e, Position, { x: 5 }));
		applyChanges(world, addC, { invert: true });
		expect(world.hasComponent(e, Position)).toBe(false);

		world.addComponent(e, Position, { x: 7, y: 8 });
		tickWorld(world);
		const remC = capture(world, () => world.removeComponent(e, Position));
		expect(world.hasComponent(e, Position)).toBe(false);
		applyChanges(world, remC, { invert: true });
		expect(world.getComponent(e, Position)).toEqual({ x: 7, y: 8 });
	});

	it('round-trips tags, relations, and resources', () => {
		const world = createWorld();
		const a = world.createEntity();
		const b = world.createEntity();

		const change = capture(world, () => {
			world.addTag(a, Tombstoned);
			world.relate(a, ChildOf, b);
			world.setResource(Camera, { zoom: 2 });
		});
		applyChanges(world, change, { invert: true });
		expect(world.hasTag(a, Tombstoned)).toBe(false);
		expect(world.getTargets(a, ChildOf)).toEqual([]);
		expect(world.getResource(Camera).zoom).toBe(1);

		applyChanges(world, change);
		expect(world.hasTag(a, Tombstoned)).toBe(true);
		expect(world.getTargets(a, ChildOf)).toEqual([b]);
		expect(world.getResource(Camera).zoom).toBe(2);
	});

	it('validate-first: throws before mutating on a dead-entity reference', () => {
		const world = createWorld();
		const a = world.createEntity();
		const b = world.createEntity();
		const change = capture(world, () => {
			world.addComponent(a, Position, { x: 1 });
			world.addComponent(b, Position, { x: 2 });
		});

		world.destroyEntity(b); // b now dead
		// a is untouched because validation throws before any write.
		expect(() => applyChanges(world, change, { invert: true })).toThrow(/dead entit/);
		expect(world.hasComponent(a, Position)).toBe(true); // not mutated
	});

	it('onMissing: skip applies the living entries and reports the rest', () => {
		const world = createWorld();
		const a = world.createEntity();
		const b = world.createEntity();
		const change = capture(world, () => {
			world.addComponent(a, Position, { x: 1 });
			world.addComponent(b, Position, { x: 2 });
		});

		world.destroyEntity(b);
		const { skipped } = applyChanges(world, change, { invert: true, onMissing: 'skip' });
		expect(world.hasComponent(a, Position)).toBe(false); // a's add was inverted (removed)
		expect(skipped.some((s) => s.reason === 'dead-entity' && s.entity === b)).toBe(true);
	});

	it('replays under a given origin (so a recorder can ignore it)', () => {
		const world = createWorld();
		const HISTORY = Symbol('history');
		const e = world.createEntity();
		world.addComponent(e, Position, { x: 1 });
		const change = capture(world, () =>
			world.updateComponent(e, Position, (p) => ({ ...p, x: 2 })),
		);

		let sawOrigin: unknown = 'unset';
		world.onComponentChanged(Position, () => {
			sawOrigin = world.mutationOrigin;
		});
		applyChanges(world, change, { invert: true, origin: HISTORY });
		expect(sawOrigin).toBe(HISTORY);
	});

	it('reports created/destroyed as lifecycle skips (never replayed)', () => {
		const world = createWorld();
		const change = capture(world, () => {
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1 });
		});
		const { skipped } = applyChanges(world, change, { onMissing: 'skip' });
		expect(skipped.some((s) => s.reason === 'lifecycle')).toBe(true);
	});

	it('the RFC recipe: drag 3, delete 1 (tombstone), undo, undo, redo', () => {
		const world = createWorld();
		const HISTORY = Symbol('history');
		const e1 = world.createEntity();
		const e2 = world.createEntity();
		const e3 = world.createEntity();
		for (const e of [e1, e2, e3]) world.addComponent(e, Position, { x: 0, y: 0 });
		tickWorld(world);

		// Recorder: only local-origin runs become undo entries.
		const undoStack: DeliveredChanges[][] = [];
		const redoStack: DeliveredChanges[][] = [];
		let gesture: DeliveredChanges[] = [];
		world.onChanges((c) => {
			if (c.origin === undefined) gesture.push(c);
		});
		const endGesture = () => {
			if (gesture.length) {
				undoStack.push(gesture);
				redoStack.length = 0;
			}
			gesture = [];
		};

		// Gesture 1 — drag all three.
		tickWorld(world, () => {
			world.updateComponent(e1, Position, (p) => ({ ...p, x: 10 }));
			world.updateComponent(e2, Position, (p) => ({ ...p, x: 20 }));
			world.updateComponent(e3, Position, (p) => ({ ...p, x: 30 }));
		});
		endGesture();

		// Gesture 2 — delete e2 by tombstoning (no destroy → identity stays valid).
		tickWorld(world, () => world.addTag(e2, Tombstoned));
		endGesture();

		expect(undoStack).toHaveLength(2);
		expect(world.hasTag(e2, Tombstoned)).toBe(true);

		const undo = () => {
			const entry = undoStack.pop();
			if (!entry) return;
			world.withOrigin(HISTORY, () => {
				for (let i = entry.length - 1; i >= 0; i--) {
					applyChanges(world, entry[i], { invert: true });
				}
			});
			redoStack.push(entry);
		};
		const redo = () => {
			const entry = redoStack.pop();
			if (!entry) return;
			world.withOrigin(HISTORY, () => {
				for (const c of entry) applyChanges(world, c);
			});
			undoStack.push(entry);
		};

		undo(); // undo the delete
		expect(world.hasTag(e2, Tombstoned)).toBe(false);
		// HISTORY-origin replays were not recorded as new gestures.
		expect(gesture).toHaveLength(0);

		undo(); // undo the drag
		expect(world.getComponent(e1, Position)).toEqual({ x: 0, y: 0 });
		expect(world.getComponent(e2, Position)).toEqual({ x: 0, y: 0 });
		expect(world.getComponent(e3, Position)).toEqual({ x: 0, y: 0 });

		redo(); // redo the drag
		expect(world.getComponent(e1, Position)).toEqual({ x: 10, y: 0 });
		expect(world.getComponent(e2, Position)).toEqual({ x: 20, y: 0 });
		expect(world.getComponent(e3, Position)).toEqual({ x: 30, y: 0 });

		// e2's identity stayed valid across the whole sequence — never destroyed.
		expect(world.entityExists(e2)).toBe(true);
	});
});
