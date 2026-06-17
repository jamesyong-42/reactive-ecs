import { describe, expect, it } from 'vitest';
import { defineComponent, defineRelation, defineResource, defineTag } from '../define.js';
import { tickWorld } from '../tick.js';
import { createWorld } from '../world.js';

const Position = defineComponent('Position', { x: 0, y: 0 });
const Velocity = defineComponent('Velocity', { dx: 0, dy: 0 });
const Selected = defineTag('Selected');
const ChildOf = defineRelation('ChildOf');
const Camera = defineResource('Camera', { x: 0, y: 0, zoom: 1 });

const keys = <K>(m: ReadonlyMap<K, unknown> | ReadonlySet<K>): K[] =>
	[...(m.keys() as Iterable<K>)].sort();

describe('changes() — value-carrying change detection (RFC-006)', () => {
	describe('component partition + values', () => {
		it('added carries the attached value and mirrors queryAdded', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 5, y: 6 });

			const added = world.changes().added(Position);
			expect([...added.keys()]).toEqual(world.queryAdded(Position));
			expect(added.get(e)).toEqual({ x: 5, y: 6 });
			expect(world.changes().changed(Position).size).toBe(0);
			expect(world.changes().removed(Position).size).toBe(0);
		});

		it('changed carries { prev, next } and prev is the WINDOW-START value', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 0 });
			world.clearDirty(); // close the window — {x:1} is now the baseline

			world.patchComponent(e, Position, { x: 2 });
			world.patchComponent(e, Position, { x: 3 });

			const changed = world.changes().changed(Position);
			expect([...changed.keys()]).toEqual(world.queryChanged(Position));
			// prev stays window-start ({x:1}) across multiple writes; next is current.
			expect(changed.get(e)).toEqual({ prev: { x: 1, y: 0 }, next: { x: 3, y: 0 } });
		});

		it('removed carries the WINDOW-START value (not the value just before removal)', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 2 });
			world.clearDirty();

			world.patchComponent(e, Position, { x: 9 }); // replaced mid-window
			world.removeComponent(e, Position);

			const removed = world.changes().removed(Position);
			expect([...removed.keys()]).toEqual(world.queryRemoved(Position));
			// Window-start value, so applyChanges(invertChanges(...)) restores it.
			expect(removed.get(e)).toEqual({ x: 1, y: 2 });
		});
	});

	describe('net transitions match the buffer partition', () => {
		it('add-then-remove in one window is invisible', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position);
			world.removeComponent(e, Position);
			const c = world.changes();
			expect(c.added(Position).size).toBe(0);
			expect(c.changed(Position).size).toBe(0);
			expect(c.removed(Position).size).toBe(0);
		});

		it('remove-then-re-add of a pre-existing component nets to changed', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 1 });
			world.clearDirty();

			world.removeComponent(e, Position);
			world.addComponent(e, Position, { x: 2, y: 2 });

			const changed = world.changes().changed(Position);
			expect([...changed.keys()]).toEqual(world.queryChanged(Position));
			expect(changed.get(e)).toEqual({ prev: { x: 1, y: 1 }, next: { x: 2, y: 2 } });
		});
	});

	describe('tags and relations', () => {
		it('addedTag / removedTag mirror the tag buffers', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.addTag(a, Selected);
			world.addTag(b, Selected);
			world.clearDirty();

			world.removeTag(a, Selected);
			const c = world.createEntity();
			world.addTag(c, Selected);

			expect(keys(world.changes().addedTag(Selected))).toEqual(
				world.queryAddedTag(Selected).sort(),
			);
			expect(keys(world.changes().removedTag(Selected))).toEqual(
				world.queryRemovedTag(Selected).sort(),
			);
			expect([...world.changes().addedTag(Selected)]).toEqual([c]);
			expect([...world.changes().removedTag(Selected)]).toEqual([a]);
		});

		it('addedRelation / removedRelation mirror the relation buffers', () => {
			const world = createWorld();
			const parent = world.createEntity();
			const child = world.createEntity();
			world.relate(child, ChildOf, parent);

			expect(world.changes().addedRelation(ChildOf)).toEqual(world.queryRelationAdded(ChildOf));
			expect(world.changes().addedRelation(ChildOf)).toEqual([[child, parent]]);

			world.clearDirty();
			world.unrelate(child, ChildOf, parent);
			expect(world.changes().removedRelation(ChildOf)).toEqual([[child, parent]]);
		});
	});

	describe('resources', () => {
		it('changedResources carries { prev, next } keyed by type', () => {
			const world = createWorld();
			world.setResource(Camera, { zoom: 1 });
			world.clearDirty();

			world.setResource(Camera, { zoom: 2 });
			world.setResource(Camera, { zoom: 3 });

			const res = world.changes().changedResources();
			expect([...res.keys()]).toEqual([Camera]);
			const entry = res.get(Camera);
			expect(entry?.prev).toMatchObject({ zoom: 1 });
			expect(entry?.next).toMatchObject({ zoom: 3 });
		});
	});

	describe('created / destroyed (netted)', () => {
		it('reports net-created and net-destroyed entities', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			expect(keys(world.changes().created)).toEqual([a, b].sort());
			expect(world.changes().destroyed.size).toBe(0);

			world.clearDirty();
			const c = world.createEntity();
			world.destroyEntity(a); // alive at window start → destroyed
			expect([...world.changes().created]).toEqual([c]);
			expect([...world.changes().destroyed]).toEqual([a]);
		});

		it('created-then-destroyed in one window is invisible', () => {
			const world = createWorld();
			world.clearDirty();
			const tmp = world.createEntity();
			world.destroyEntity(tmp);
			const c = world.changes();
			expect(c.created.size).toBe(0);
			expect(c.destroyed.size).toBe(0);
		});

		it('a destroyed entity exposes its dying components under removed()', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 7, y: 8 });
			world.clearDirty();

			world.destroyEntity(e);
			expect([...world.changes().destroyed]).toEqual([e]);
			expect(world.changes().removed(Position).get(e)).toEqual({ x: 7, y: 8 });
		});
	});

	describe('accessor stability', () => {
		it('each accessor call materializes a fresh container; iterating while mutating is safe', () => {
			const world = createWorld();
			const a = world.createEntity();
			world.addComponent(a, Position, { x: 1 });

			const snap = world.changes().added(Position);
			// Mutate the world while iterating the materialized snapshot.
			expect(() => {
				for (const _ of snap) {
					const n = world.createEntity();
					world.addComponent(n, Position, { x: 2 });
				}
			}).not.toThrow();
			// The held snapshot is unaffected by the writes made during iteration…
			expect(snap.size).toBe(1);
			// …but a fresh call reflects them.
			expect(world.changes().added(Position).size).toBeGreaterThan(1);
		});
	});

	describe('tick + isEmpty', () => {
		it('tick reflects currentTick', () => {
			const world = createWorld();
			expect(world.changes().tick).toBe(world.currentTick);
			tickWorld(world);
			expect(world.changes().tick).toBe(world.currentTick);
		});

		it('isEmpty is true with no changes and false after any', () => {
			const world = createWorld();
			expect(world.changes().isEmpty()).toBe(true);
			const e = world.createEntity();
			expect(world.changes().isEmpty()).toBe(false); // created
			world.clearDirty();
			expect(world.changes().isEmpty()).toBe(true);
			world.addComponent(e, Position);
			expect(world.changes().isEmpty()).toBe(false);
		});
	});

	describe('getRegisteredRelations', () => {
		it('returns relation types that have had a store created', () => {
			const world = createWorld();
			expect(world.getRegisteredRelations()).toEqual([]);
			const a = world.createEntity();
			const b = world.createEntity();
			world.relate(a, ChildOf, b);
			expect(world.getRegisteredRelations()).toContain(ChildOf);
		});
	});

	describe('re-entrancy depth guard', () => {
		it('throws a loud cycle error on a handler→mutate→handler feedback loop', () => {
			const world = createWorld({ maxReentrancyDepth: 50 });
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0 });
			world.clearDirty();

			world.onComponentChanged(Position, () => {
				world.patchComponent(e, Position, { x: 1 }); // re-triggers this handler
			});

			expect(() => world.patchComponent(e, Position, { x: 1 })).toThrow(/re-entrancy/);
		});

		it('does not fire for normal nested handler chains within the cap', () => {
			const world = createWorld({ maxReentrancyDepth: 50 });
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0 });
			world.addComponent(e, Velocity, { dx: 0 });
			world.clearDirty();

			// Position change writes Velocity once — depth 2, well under the cap.
			world.onComponentChanged(Position, () => {
				world.patchComponent(e, Velocity, { dx: 1 });
			});
			expect(() => world.patchComponent(e, Position, { x: 1 })).not.toThrow();
			expect(world.getComponent(e, Velocity)).toEqual({ dx: 1, dy: 0 });
		});
	});
});
