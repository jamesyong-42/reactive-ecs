import { describe, expect, it, vi } from 'vitest';
import { defineComponent, defineRelation, defineResource, defineTag, Not } from '../define.js';
import { createWorld } from '../world.js';

const Position = defineComponent('Position', { x: 0, y: 0 });
const Velocity = defineComponent('Velocity', { dx: 0, dy: 0 });
const Label = defineComponent('Label', { text: '' });
const Selected = defineTag('Selected');
const Visible = defineTag('Visible');
const Camera = defineResource('Camera', { x: 0, y: 0, zoom: 1 });

describe('World', () => {
	describe('entities', () => {
		it('creates entities with unique ids', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			expect(a).not.toBe(b);
			expect(world.entityExists(a)).toBe(true);
			expect(world.entityExists(b)).toBe(true);
		});

		it('destroys entities', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 10, y: 20 });
			world.addTag(e, Selected);
			world.destroyEntity(e);
			expect(world.entityExists(e)).toBe(false);
			expect(world.getComponent(e, Position)).toBeUndefined();
			expect(world.hasTag(e, Selected)).toBe(false);
		});
	});

	describe('components', () => {
		it('adds and gets components with defaults merged', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 42 });
			const pos = world.getComponent(e, Position);
			expect(pos).toBeDefined();
			if (!pos) throw new Error('Position component missing');
			expect(pos.x).toBe(42);
			expect(pos.y).toBe(0); // default
		});

		it('addComponent with no data attaches pure defaults', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position);
			expect(world.getComponent(e, Position)).toEqual({ x: 0, y: 0 });
		});

		it('re-add on an entity that already has the component is an honest replace', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 2 });
			world.clearDirty();

			const handler = vi.fn();
			world.onComponentChanged(Position, handler);
			world.addComponent(e, Position, { x: 9 });

			// Observers see the existing value as prev — never a fake first attach.
			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledWith(e, { x: 1, y: 2 }, { x: 9, y: 0 });
			// The replace lands in queryChanged but NOT in queryAdded.
			expect(world.queryChanged(Position)).toEqual([e]);
			expect(world.queryAdded(Position)).toEqual([]);
		});

		it('remove-then-re-add in the same tick is a net present→present — queryChanged only', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 2 });
			world.clearDirty();

			const handler = vi.fn();
			world.onComponentChanged(Position, handler);
			world.removeComponent(e, Position);
			world.addComponent(e, Position, { x: 5 });

			// Events are per-mutation: the component was absent at add time.
			expect(handler).toHaveBeenCalledWith(e, undefined, { x: 5, y: 0 });
			// Buffers are net: present at the last clearDirty() and present now.
			expect(world.queryChanged(Position)).toEqual([e]);
			expect(world.queryAdded(Position)).toEqual([]);
			expect(world.queryRemoved(Position)).toEqual([]);
		});

		it('patches partial component data', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 10, y: 20 });
			world.patchComponent(e, Position, { x: 99 });
			const pos = world.getComponent(e, Position);
			expect(pos).toBeDefined();
			if (!pos) throw new Error('Position component missing');
			expect(pos.x).toBe(99);
			expect(pos.y).toBe(20); // unchanged
		});

		it('removes components', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 2 });
			expect(world.hasComponent(e, Position)).toBe(true);
			world.removeComponent(e, Position);
			expect(world.hasComponent(e, Position)).toBe(false);
			expect(world.getComponent(e, Position)).toBeUndefined();
		});

		it('handles string/object data in components', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Label, { text: 'Hello World' });
			expect(world.getComponent(e, Label)?.text).toBe('Hello World');
		});

		it('defaults containing an array of objects are not shared between entities', () => {
			const Path = defineComponent('Path', { points: [{ x: 0 }] });
			const world = createWorld();
			const e1 = world.createEntity();
			const e2 = world.createEntity();
			world.addComponent(e1, Path);
			world.addComponent(e2, Path);

			const p1 = world.getComponent(e1, Path);
			const p2 = world.getComponent(e2, Path);
			if (!p1 || !p2) throw new Error('Path component missing');
			// Objects inside arrays are cloned per entity — distinct identities.
			expect(p1.points[0]).not.toBe(p2.points[0]);
			expect(p1.points[0]).not.toBe(Path.defaults.points[0]);
			expect(p1.points[0]).toEqual({ x: 0 });
		});

		it('class instances in init data are kept by reference', () => {
			class SpatialIndex {}
			const Indexed = defineComponent('Indexed', { index: null as SpatialIndex | null });
			const world = createWorld();
			const e = world.createEntity();
			const instance = new SpatialIndex();
			world.addComponent(e, Indexed, { index: instance });
			expect(world.getComponent(e, Indexed)?.index).toBe(instance);
		});
	});

	describe('patchComponent', () => {
		it('shallow-merges one level — untouched fields survive', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 2 });
			world.patchComponent(e, Position, { x: 9 });
			expect(world.getComponent(e, Position)).toEqual({ x: 9, y: 2 });
		});

		it('nested objects in the patch replace wholesale — the merge is one level deep', () => {
			const Style = defineComponent('PatchStyle', {
				fill: { color: 'red', opacity: 1 } as Record<string, unknown>,
			});
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Style);
			world.patchComponent(e, Style, { fill: { color: 'blue' } });
			// The nested object is replaced, not merged — opacity is gone.
			expect(world.getComponent(e, Style)).toEqual({ fill: { color: 'blue' } });
		});

		it('emits onComponentChanged with a top-level prev snapshot and lands in queryChanged', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 2 });
			world.clearDirty();

			const handler = vi.fn();
			world.onComponentChanged(Position, handler);
			world.patchComponent(e, Position, { x: 9 });

			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledWith(e, { x: 1, y: 2 }, { x: 9, y: 2 });
			expect(world.queryChanged(Position)).toEqual([e]);
			expect(world.queryAdded(Position)).toEqual([]);
		});

		it('throws on a dead entity — absence is never silent', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			world.destroyEntity(e);
			expect(() => world.patchComponent(e, Position, { x: 1 })).toThrow(
				`patchComponent(Position): entity ${e} does not exist or has been destroyed`,
			);
		});

		it('throws when the entity is alive but lacks the component', () => {
			const world = createWorld();
			const e = world.createEntity();
			expect(() => world.patchComponent(e, Position, { x: 1 })).toThrow(
				`patchComponent(Position): entity ${e} has no Position — use addComponent to attach`,
			);
		});
	});

	describe('tags', () => {
		it('adds and checks tags', () => {
			const world = createWorld();
			const e = world.createEntity();
			expect(world.hasTag(e, Selected)).toBe(false);
			world.addTag(e, Selected);
			expect(world.hasTag(e, Selected)).toBe(true);
		});

		it('removes tags', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addTag(e, Selected);
			world.removeTag(e, Selected);
			expect(world.hasTag(e, Selected)).toBe(false);
		});

		it('adding tag twice is idempotent', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addTag(e, Selected);
			world.addTag(e, Selected);
			expect(world.hasTag(e, Selected)).toBe(true);
		});
	});

	describe('queries', () => {
		it('queries entities by component', () => {
			const world = createWorld();
			const e1 = world.createEntity();
			const e2 = world.createEntity();
			const e3 = world.createEntity();
			world.addComponent(e1, Position, { x: 0, y: 0 });
			world.addComponent(e2, Position, { x: 1, y: 1 });
			world.addComponent(e2, Velocity, { dx: 1, dy: 0 });
			world.addComponent(e3, Velocity, { dx: 2, dy: 2 });

			const withPosition = world.query(Position);
			expect(withPosition).toHaveLength(2);
			expect(withPosition).toContain(e1);
			expect(withPosition).toContain(e2);

			const withBoth = world.query(Position, Velocity);
			expect(withBoth).toHaveLength(1);
			expect(withBoth).toContain(e2);
		});

		it('queries entities by tag', () => {
			const world = createWorld();
			const e1 = world.createEntity();
			const e2 = world.createEntity();
			world.addTag(e1, Selected);
			world.addTag(e1, Visible);
			world.addTag(e2, Visible);

			const selected = world.query(Selected);
			expect(selected).toEqual([e1]);

			const visible = world.query(Visible);
			expect(visible).toHaveLength(2);
		});

		it('queries with mixed components and tags', () => {
			const world = createWorld();
			const e1 = world.createEntity();
			const e2 = world.createEntity();
			world.addComponent(e1, Position, { x: 0, y: 0 });
			world.addTag(e1, Visible);
			world.addComponent(e2, Position, { x: 1, y: 1 });

			const result = world.query(Position, Visible);
			expect(result).toEqual([e1]);
		});

		it('queryChanged returns written entities — fresh adds land in queryAdded only', () => {
			const world = createWorld();
			const e1 = world.createEntity();
			const e2 = world.createEntity();
			world.addComponent(e1, Position, { x: 0, y: 0 });
			world.addComponent(e2, Position, { x: 1, y: 1 });

			// A fresh attach is absent→present: added only, never changed.
			expect(world.queryChanged(Position)).toHaveLength(0);
			expect(world.queryAdded(Position)).toHaveLength(2);

			// Clear dirty
			world.clearDirty();

			// Only e1 is dirty after patch
			world.patchComponent(e1, Position, { x: 99 });
			const changed = world.queryChanged(Position);
			expect(changed).toHaveLength(1);
			expect(changed).toContain(e1);
		});

		it('queryTagged returns all entities with a tag', () => {
			const world = createWorld();
			const e1 = world.createEntity();
			const e2 = world.createEntity();
			world.addTag(e1, Selected);
			world.addTag(e2, Selected);

			const tagged = world.queryTagged(Selected);
			expect(tagged).toHaveLength(2);
		});

		it('queryRemoved returns entities that lost a component this tick', () => {
			const world = createWorld();
			const e1 = world.createEntity();
			const e2 = world.createEntity();
			world.addComponent(e1, Position, { x: 0, y: 0 });
			world.addComponent(e2, Position, { x: 1, y: 1 });
			world.clearDirty();

			world.removeComponent(e1, Position);
			const removed = world.queryRemoved(Position);
			expect(removed).toHaveLength(1);
			expect(removed).toContain(e1);
		});

		it('queryRemoved is cleared by clearDirty', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			world.clearDirty();
			world.removeComponent(e, Position);
			expect(world.queryRemoved(Position)).toHaveLength(1);
			world.clearDirty();
			expect(world.queryRemoved(Position)).toHaveLength(0);
		});

		it('remove-then-add of a component present at tick start nets to queryChanged', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 2 });
			world.clearDirty();

			// remove then add → net present→present: `changed` only
			world.removeComponent(e, Position);
			expect(world.queryRemoved(Position)).toEqual([e]);
			world.addComponent(e, Position, { x: 9, y: 9 });
			expect(world.queryRemoved(Position)).toEqual([]);
			expect(world.queryAdded(Position)).toEqual([]);
			expect(world.queryChanged(Position)).toEqual([e]);
		});

		it('add-then-remove in the same tick is a net absent→absent — no buffer', () => {
			const world = createWorld();
			const e = world.createEntity();
			// add then remove (no prior state) → all three buffers empty
			world.addComponent(e, Position, { x: 0, y: 0 });
			expect(world.queryAdded(Position)).toEqual([e]);
			world.removeComponent(e, Position);
			expect(world.queryAdded(Position)).toEqual([]);
			expect(world.queryChanged(Position)).toEqual([]);
			expect(world.queryRemoved(Position)).toEqual([]);
		});

		it('queryRemoved includes entities torn down by destroyEntity', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			world.clearDirty();
			world.destroyEntity(e);
			expect(world.queryRemoved(Position)).toEqual([e]);
		});

		it('queryAddedTag returns entities that gained a tag this tick', () => {
			const world = createWorld();
			const e1 = world.createEntity();
			const e2 = world.createEntity();
			world.addTag(e1, Selected);
			world.addTag(e2, Selected);

			const added = world.queryAddedTag(Selected);
			expect(added).toHaveLength(2);
			expect(added).toContain(e1);
			expect(added).toContain(e2);

			world.clearDirty();
			expect(world.queryAddedTag(Selected)).toHaveLength(0);
		});

		it('addTag-then-removeTag in the same tick is a net absent→absent — no buffer', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addTag(e, Selected);
			expect(world.queryAddedTag(Selected)).toEqual([e]);
			world.removeTag(e, Selected);
			expect(world.queryAddedTag(Selected)).toEqual([]);
			expect(world.queryRemovedTag(Selected)).toEqual([]);
		});

		it('queryRemovedTag returns entities that lost a tag this tick', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addTag(e, Selected);
			world.clearDirty();
			world.removeTag(e, Selected);
			expect(world.queryRemovedTag(Selected)).toEqual([e]);
		});

		it('removeTag-then-addTag of a tag held at tick start is vacuous — no buffer', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addTag(e, Selected);
			world.clearDirty();
			world.removeTag(e, Selected);
			expect(world.queryRemovedTag(Selected)).toEqual([e]);
			world.addTag(e, Selected);
			// Net present→present and tags have no changed buffer — nothing.
			expect(world.queryRemovedTag(Selected)).toEqual([]);
			expect(world.queryAddedTag(Selected)).toEqual([]);
		});

		it('queryRemovedTag includes entities torn down by destroyEntity', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addTag(e, Selected);
			world.clearDirty();
			world.destroyEntity(e);
			expect(world.queryRemovedTag(Selected)).toEqual([e]);
		});

		it('clearDirty empties tag added/removed buffers', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addTag(e, Selected);
			world.clearDirty();
			expect(world.queryAddedTag(Selected)).toEqual([]);
			world.removeTag(e, Selected);
			world.clearDirty();
			expect(world.queryRemovedTag(Selected)).toEqual([]);
		});

		it('removeComponent on an entity without the component does not populate queryRemoved', () => {
			const world = createWorld();
			const e = world.createEntity();
			// no Position attached
			world.removeComponent(e, Position);
			expect(world.queryRemoved(Position)).toEqual([]);
		});
	});

	describe('per-tick buffer partition', () => {
		// The three buffers partition entities by NET transition since the last
		// clearDirty(): absent→present = added; present→present with ≥1 write =
		// changed; present→absent = removed; absent→absent = nothing.

		it('add + patch in the same tick → added only', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1 });
			world.patchComponent(e, Position, { y: 2 });
			expect(world.queryAdded(Position)).toEqual([e]);
			expect(world.queryChanged(Position)).toEqual([]);
			expect(world.queryRemoved(Position)).toEqual([]);
		});

		it('patch only → changed only', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1 });
			world.clearDirty();
			world.patchComponent(e, Position, { x: 2 });
			expect(world.queryChanged(Position)).toEqual([e]);
			expect(world.queryAdded(Position)).toEqual([]);
			expect(world.queryRemoved(Position)).toEqual([]);
		});

		it('re-add (replace) of a component present at tick start → changed only', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1 });
			world.clearDirty();
			world.addComponent(e, Position, { x: 2 });
			expect(world.queryChanged(Position)).toEqual([e]);
			expect(world.queryAdded(Position)).toEqual([]);
		});

		it('destroy of a pre-existing component/tag owner → removed only', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1 });
			world.addTag(e, Selected);
			world.clearDirty();
			world.destroyEntity(e);
			expect(world.queryRemoved(Position)).toEqual([e]);
			expect(world.queryChanged(Position)).toEqual([]);
			expect(world.queryAdded(Position)).toEqual([]);
			expect(world.queryRemovedTag(Selected)).toEqual([e]);
			expect(world.queryAddedTag(Selected)).toEqual([]);
		});

		it('create + add + destroy in the same tick → no buffer at all', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1 });
			world.patchComponent(e, Position, { x: 2 });
			world.addTag(e, Selected);
			world.destroyEntity(e);
			expect(world.queryAdded(Position)).toEqual([]);
			expect(world.queryChanged(Position)).toEqual([]);
			expect(world.queryRemoved(Position)).toEqual([]);
			expect(world.queryAddedTag(Selected)).toEqual([]);
			expect(world.queryRemovedTag(Selected)).toEqual([]);
		});

		it('patch after destroy-survivor remove still classifies against tick start', () => {
			// remove → re-add → patch, all same tick, component present at start:
			// the entity stays a net present→present write — changed only.
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1 });
			world.clearDirty();
			world.removeComponent(e, Position);
			world.addComponent(e, Position, { x: 5 });
			world.patchComponent(e, Position, { y: 9 });
			expect(world.queryChanged(Position)).toEqual([e]);
			expect(world.queryAdded(Position)).toEqual([]);
			expect(world.queryRemoved(Position)).toEqual([]);
		});

		it('the partition resets at clearDirty — next tick classifies against the new baseline', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1 });
			world.clearDirty();
			world.removeComponent(e, Position);
			world.clearDirty();
			// Present→absent happened LAST tick; this tick the add is a true attach.
			world.addComponent(e, Position, { x: 2 });
			expect(world.queryAdded(Position)).toEqual([e]);
			expect(world.queryChanged(Position)).toEqual([]);
		});
	});

	describe('Not() query terms', () => {
		it('excludes entities holding the negated component', () => {
			const world = createWorld();
			const moving = world.createEntity();
			const still = world.createEntity();
			world.addComponent(moving, Position, { x: 0, y: 0 });
			world.addComponent(moving, Velocity, { dx: 1, dy: 0 });
			world.addComponent(still, Position, { x: 1, y: 1 });

			expect(world.query(Position, Not(Velocity))).toEqual([still]);
		});

		it('adding the negated component evicts from the cached result; removing re-admits', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			expect(world.query(Position, Not(Velocity))).toEqual([e]);

			world.addComponent(e, Velocity, { dx: 1, dy: 0 });
			expect(world.query(Position, Not(Velocity))).toEqual([]);

			world.removeComponent(e, Velocity);
			expect(world.query(Position, Not(Velocity))).toEqual([e]);
		});

		it('adding the negated tag evicts from the cached result; removing re-admits', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			expect(world.query(Position, Not(Selected))).toEqual([e]);

			world.addTag(e, Selected);
			expect(world.query(Position, Not(Selected))).toEqual([]);

			world.removeTag(e, Selected);
			expect(world.query(Position, Not(Selected))).toEqual([e]);
		});

		it('treats a negated type whose store was never created as absent', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			// Velocity and Visible stores never created in this world
			expect(world.query(Position, Not(Velocity))).toEqual([e]);
			expect(world.query(Position, Not(Visible))).toEqual([e]);
		});

		it('destroyEntity removes the entity from a Not-query cached result', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			expect(world.query(Position, Not(Velocity))).toEqual([e]);

			world.destroyEntity(e);
			expect(world.query(Position, Not(Velocity))).toEqual([]);
		});

		it('throws on a query of only Not() terms', () => {
			const world = createWorld();
			expect(() => world.query(Not(Velocity))).toThrow(
				'query() requires at least one positive term',
			);
		});

		it('query(A, Not(A)) is legal and always empty', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			expect(world.query(Position, Not(Position))).toEqual([]);
		});

		it('structurally identical Not-queries hit the same cache regardless of term order', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			// First call builds the cache; the reordered call must read the same
			// live set, so an eviction is visible through both spellings.
			expect(world.query(Position, Not(Velocity))).toEqual([e]);
			expect(world.query(Not(Velocity), Position)).toEqual([e]);
			world.addComponent(e, Velocity, { dx: 1, dy: 0 });
			expect(world.query(Not(Velocity), Position)).toEqual([]);
			expect(world.query(Position, Not(Velocity))).toEqual([]);
		});

		it('component and tag sharing a name never share a cache key — component queried first', () => {
			// Repro for the aliasing bug: bare type names in the cache key let
			// query(Position, SelectedComponent) and query(Position, SelectedTag)
			// collide and return each other's results.
			const SelectedComponent = defineComponent('Selected', { weight: 0 });
			const world = createWorld();
			const viaComponent = world.createEntity();
			const viaTag = world.createEntity();
			world.addComponent(viaComponent, Position, { x: 0, y: 0 });
			world.addComponent(viaComponent, SelectedComponent, { weight: 1 });
			world.addComponent(viaTag, Position, { x: 1, y: 1 });
			world.addTag(viaTag, Selected);

			expect(world.query(Position, SelectedComponent)).toEqual([viaComponent]);
			expect(world.query(Position, Selected)).toEqual([viaTag]);
		});

		it('component and tag sharing a name never share a cache key — tag queried first', () => {
			const SelectedComponent = defineComponent('Selected', { weight: 0 });
			const world = createWorld();
			const viaComponent = world.createEntity();
			const viaTag = world.createEntity();
			world.addComponent(viaComponent, Position, { x: 0, y: 0 });
			world.addComponent(viaComponent, SelectedComponent, { weight: 1 });
			world.addComponent(viaTag, Position, { x: 1, y: 1 });
			world.addTag(viaTag, Selected);

			expect(world.query(Position, Selected)).toEqual([viaTag]);
			expect(world.query(Position, SelectedComponent)).toEqual([viaComponent]);
		});

		it('Not(component) and Not(tag) sharing a name never share a cache key, in either order', () => {
			const SelectedComponent = defineComponent('Selected', { weight: 0 });
			const world = createWorld();
			const viaComponent = world.createEntity();
			const viaTag = world.createEntity();
			world.addComponent(viaComponent, Position, { x: 0, y: 0 });
			world.addComponent(viaComponent, SelectedComponent, { weight: 1 });
			world.addComponent(viaTag, Position, { x: 1, y: 1 });
			world.addTag(viaTag, Selected);

			expect(world.query(Position, Not(SelectedComponent))).toEqual([viaTag]);
			expect(world.query(Position, Not(Selected))).toEqual([viaComponent]);
			// Re-read in the opposite order — both cached sets stay correct.
			expect(world.query(Position, Not(Selected))).toEqual([viaComponent]);
			expect(world.query(Position, Not(SelectedComponent))).toEqual([viaTag]);
		});

		it('query(A, Not(B)) and query(A, B) never share a cache key', () => {
			const world = createWorld();
			const both = world.createEntity();
			const posOnly = world.createEntity();
			world.addComponent(both, Position, { x: 0, y: 0 });
			world.addComponent(both, Velocity, { dx: 1, dy: 0 });
			world.addComponent(posOnly, Position, { x: 1, y: 1 });

			expect(world.query(Position, Velocity)).toEqual([both]);
			expect(world.query(Position, Not(Velocity))).toEqual([posOnly]);
		});
	});

	describe('resources', () => {
		it('gets resource with defaults', () => {
			const world = createWorld();
			const cam = world.getResource(Camera);
			expect(cam).toEqual({ x: 0, y: 0, zoom: 1 });
		});

		it('sets partial resource data', () => {
			const world = createWorld();
			world.setResource(Camera, { zoom: 2.5 });
			const cam = world.getResource(Camera);
			expect(cam.zoom).toBe(2.5);
			expect(cam.x).toBe(0); // unchanged
		});
	});

	describe('resource observability', () => {
		const Settings = defineResource('Settings', { volume: 1, muted: false });

		it('onResourceChanged receives a pre-merge prev snapshot and the live post-merge next', () => {
			const world = createWorld();
			world.setResource(Camera, { x: 5 });

			let seenPrev: { x: number; y: number; zoom: number } | undefined;
			let seenNext: { x: number; y: number; zoom: number } | undefined;
			world.onResourceChanged(Camera, (prev, next) => {
				seenPrev = prev;
				seenNext = next;
			});

			world.setResource(Camera, { zoom: 2 });
			expect(seenPrev).toEqual({ x: 5, y: 0, zoom: 1 });
			expect(seenNext).toEqual({ x: 5, y: 0, zoom: 2 });
			// next is the live value; prev is a snapshot that never aliases it
			expect(seenNext).toBe(world.getResource(Camera));
			expect(seenPrev).not.toBe(seenNext);
		});

		it('fires on the first setResource with the defaults-only value as prev', () => {
			const world = createWorld();
			const handler = vi.fn();
			world.onResourceChanged(Camera, handler);

			world.setResource(Camera, { zoom: 3 });
			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledWith({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, zoom: 3 });
		});

		it('fires on every setResource, not just the first', () => {
			const world = createWorld();
			const handler = vi.fn();
			world.onResourceChanged(Camera, handler);

			world.setResource(Camera, { x: 1 });
			world.setResource(Camera, { x: 2 });
			expect(handler).toHaveBeenCalledTimes(2);
			expect(handler).toHaveBeenLastCalledWith({ x: 1, y: 0, zoom: 1 }, { x: 2, y: 0, zoom: 1 });
		});

		it('lazy getResource fires nothing and does not count as a change', () => {
			const world = createWorld();
			const handler = vi.fn();
			world.onResourceChanged(Camera, handler);

			world.getResource(Camera);
			expect(handler).not.toHaveBeenCalled();
			expect(world.queryChangedResources()).toEqual([]);
		});

		it('multiple handlers fire in subscription order', () => {
			const world = createWorld();
			const order: string[] = [];
			world.onResourceChanged(Camera, () => order.push('first'));
			world.onResourceChanged(Camera, () => order.push('second'));

			world.setResource(Camera, { x: 1 });
			expect(order).toEqual(['first', 'second']);
		});

		it('unsubscribes handlers', () => {
			const world = createWorld();
			const handler = vi.fn();
			const unsub = world.onResourceChanged(Camera, handler);

			world.setResource(Camera, { x: 1 });
			expect(handler).toHaveBeenCalledTimes(1);

			unsub();
			world.setResource(Camera, { x: 2 });
			expect(handler).toHaveBeenCalledTimes(1); // not called again
		});

		it('queryChangedResources contains the type after setResource', () => {
			const world = createWorld();
			world.setResource(Camera, { zoom: 2 });
			expect(world.queryChangedResources()).toEqual([Camera]);
		});

		it('queryChangedResources dedupes multiple sets of the same resource in one tick', () => {
			const world = createWorld();
			world.setResource(Camera, { x: 1 });
			world.setResource(Camera, { x: 2 });
			expect(world.queryChangedResources()).toEqual([Camera]);
		});

		it('queryChangedResources is cleared by clearDirty', () => {
			const world = createWorld();
			world.setResource(Camera, { x: 1 });
			expect(world.queryChangedResources()).toEqual([Camera]);

			world.clearDirty();
			expect(world.queryChangedResources()).toEqual([]);
		});

		it('queryChangedResources lists distinct resources in first-changed order', () => {
			const world = createWorld();
			world.setResource(Settings, { volume: 0.5 });
			world.setResource(Camera, { x: 1 });
			world.setResource(Settings, { muted: true }); // re-set does not reorder
			expect(world.queryChangedResources()).toEqual([Settings, Camera]);
		});

		it('handlers read the withOrigin origin, and undefined outside any window', () => {
			const world = createWorld();
			const REMOTE = Symbol('remote');
			const seen: (string | symbol | undefined)[] = [];
			world.onResourceChanged(Camera, () => seen.push(world.mutationOrigin));

			world.withOrigin(REMOTE, () => world.setResource(Camera, { x: 1 }));
			world.setResource(Camera, { x: 2 });
			expect(seen).toEqual([REMOTE, undefined]);
		});
	});

	describe('events', () => {
		it('fires component changed events', () => {
			const world = createWorld();
			const handler = vi.fn();
			world.onComponentChanged(Position, handler);

			const e = world.createEntity();
			world.addComponent(e, Position, { x: 10, y: 20 });

			expect(handler).toHaveBeenCalledWith(e, undefined, { x: 10, y: 20 });
		});

		it('fires tag added/removed events', () => {
			const world = createWorld();
			const added = vi.fn();
			const removed = vi.fn();
			world.onTagAdded(Selected, added);
			world.onTagRemoved(Selected, removed);

			const e = world.createEntity();
			world.addTag(e, Selected);
			expect(added).toHaveBeenCalledWith(e);

			world.removeTag(e, Selected);
			expect(removed).toHaveBeenCalledWith(e);
		});

		it('unsubscribes handlers', () => {
			const world = createWorld();
			const handler = vi.fn();
			const unsub = world.onComponentChanged(Position, handler);

			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 2 });
			expect(handler).toHaveBeenCalledTimes(1);

			unsub();
			world.patchComponent(e, Position, { x: 99 });
			expect(handler).toHaveBeenCalledTimes(1); // not called again
		});

		it('onComponentRemoved fires on removeComponent with the prev value', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 5, y: 7 });

			const handler = vi.fn();
			world.onComponentRemoved(Position, handler);
			world.removeComponent(e, Position);
			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledWith(e, { x: 5, y: 7 });
		});

		it('onComponentRemoved fires once per owned component during destroyEntity', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 2 });
			world.addComponent(e, Velocity, { dx: 3, dy: 4 });

			const pos = vi.fn();
			const vel = vi.fn();
			world.onComponentRemoved(Position, pos);
			world.onComponentRemoved(Velocity, vel);

			world.destroyEntity(e);
			expect(pos).toHaveBeenCalledWith(e, { x: 1, y: 2 });
			expect(vel).toHaveBeenCalledWith(e, { dx: 3, dy: 4 });
		});

		it('onComponentRemoved per-entity filter only fires for that entity', () => {
			const world = createWorld();
			const e1 = world.createEntity();
			const e2 = world.createEntity();
			world.addComponent(e1, Position, { x: 1, y: 1 });
			world.addComponent(e2, Position, { x: 2, y: 2 });

			const handler = vi.fn();
			world.onComponentRemoved(Position, handler, e1);
			world.removeComponent(e2, Position);
			expect(handler).not.toHaveBeenCalled();
			world.removeComponent(e1, Position);
			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledWith(e1, { x: 1, y: 1 });
		});

		it('onComponentRemoved fires per-entity handler before wildcard', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });

			const order: string[] = [];
			world.onComponentRemoved(Position, () => order.push('wildcard'));
			world.onComponentRemoved(Position, () => order.push('entity'), e);
			world.removeComponent(e, Position);
			expect(order).toEqual(['entity', 'wildcard']);
		});

		it('onComponentRemoved unsubscribes', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });

			const handler = vi.fn();
			const unsub = world.onComponentRemoved(Position, handler);
			unsub();
			world.removeComponent(e, Position);
			expect(handler).not.toHaveBeenCalled();
		});

		it('onTagRemoved fires from destroyEntity for each owned tag', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addTag(e, Selected);
			world.addTag(e, Visible);

			const sel = vi.fn();
			const vis = vi.fn();
			world.onTagRemoved(Selected, sel);
			world.onTagRemoved(Visible, vis);

			world.destroyEntity(e);
			expect(sel).toHaveBeenCalledWith(e);
			expect(vis).toHaveBeenCalledWith(e);
		});

		it('onComponentRemoved sees prev value at the call site even during destroy', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Label, { text: 'goodbye' });

			let seenPrev: { text: string } | undefined;
			world.onComponentRemoved(Label, (_id, prev) => {
				seenPrev = prev;
			});

			world.destroyEntity(e);
			expect(seenPrev).toEqual({ text: 'goodbye' });
		});
	});

	describe('name collisions', () => {
		it('throws when two different ComponentTypes share a name', () => {
			const A = defineComponent('Duplicate', { x: 0 });
			const B = defineComponent('Duplicate', { y: 0 });
			const world = createWorld();
			const e = world.createEntity();

			world.addComponent(e, A, { x: 1 });
			expect(() => world.addComponent(e, B, { y: 1 })).toThrow(/Component name collision/i);
		});

		it('throws when two different TagTypes share a name', () => {
			const A = defineTag('DupeTag');
			const B = defineTag('DupeTag');
			const world = createWorld();
			const e = world.createEntity();

			world.addTag(e, A);
			expect(() => world.addTag(e, B)).toThrow(/Tag name collision/i);
		});

		it('throws when two different ResourceTypes share a name', () => {
			const A = defineResource('DupeRes', { x: 0 });
			const B = defineResource('DupeRes', { y: 0 });
			const world = createWorld();

			world.getResource(A);
			expect(() => world.getResource(B)).toThrow(/Resource name collision/i);
		});
	});

	describe('mutation guard during the destroy sweep', () => {
		const GUARD = /cannot mutate the world from a handler during entity teardown/;

		it('a handler mutating during destroy throws — addComponent / patchComponent / destroyEntity / relate', () => {
			const world = createWorld();
			const e = world.createEntity();
			const other = world.createEntity();
			world.addComponent(e, Position, { x: 1, y: 1 });
			world.addComponent(other, Position, { x: 2, y: 2 });

			let checked = false;
			world.onComponentRemoved(Position, (id) => {
				if (id !== e) return;
				expect(() => world.addComponent(other, Velocity, { dx: 1 })).toThrow(GUARD);
				expect(() => world.patchComponent(other, Position, { x: 9 })).toThrow(GUARD);
				expect(() => world.destroyEntity(other)).toThrow(GUARD);
				expect(() => world.relate(other, defineRelation('GuardRel'), other)).toThrow(GUARD);
				checked = true;
			});

			world.destroyEntity(e);
			expect(checked).toBe(true);
			// The world is intact after the rejected mutations.
			expect(world.entityExists(other)).toBe(true);
			expect(world.getComponent(other, Position)).toEqual({ x: 2, y: 2 });
		});

		it('onEntityDestroyed and onTagRemoved are inside the guard too', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addTag(e, Selected);

			let checks = 0;
			world.onEntityDestroyed(() => {
				expect(() => world.createEntity()).toThrow(GUARD);
				expect(() => world.setResource(Camera, { x: 1 })).toThrow(GUARD);
				checks++;
			});
			world.onTagRemoved(Selected, () => {
				expect(() => world.addTag(e, Visible)).toThrow(GUARD);
				expect(() => world.removeTag(e, Selected)).toThrow(GUARD);
				checks++;
			});

			world.destroyEntity(e);
			expect(checks).toBe(2);
		});

		it('handler mutations OUTSIDE a destroy still work', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.onComponentChanged(Position, (id) => {
				// Observe-and-mutate outside teardown is legal.
				world.addTag(id, Selected);
			});
			world.addComponent(e, Position, { x: 1, y: 1 });
			expect(world.hasTag(e, Selected)).toBe(true);
			// And a later removeComponent outside destroy works as before.
			world.removeComponent(e, Position);
			expect(world.hasComponent(e, Position)).toBe(false);
		});

		it('onTargetDestroy policy effects still apply after the sweep — cascade and { tag }', () => {
			const Cancelled = defineTag('GuardCancelled');
			const CascadeRel = defineRelation('GuardCascade', { onTargetDestroy: 'cascade' });
			const TagRel = defineRelation('GuardTag', { onTargetDestroy: { tag: Cancelled } });
			const world = createWorld();
			const chrome = world.createEntity();
			const watcher = world.createEntity();
			const target = world.createEntity();
			world.relate(chrome, CascadeRel, target);
			world.relate(watcher, TagRel, target);

			// The deferred effects are the world's own mutations — legal.
			world.destroyEntity(target);
			expect(world.entityExists(chrome)).toBe(false);
			expect(world.hasTag(watcher, Cancelled)).toBe(true);
		});

		it('nested cascade destroys still work — the guard lifts between sweeps', () => {
			const ChainRel = defineRelation('GuardChain', { onTargetDestroy: 'cascade' });
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			const c = world.createEntity();
			world.relate(a, ChainRel, b);
			world.relate(b, ChainRel, c);

			world.destroyEntity(c);
			expect(world.entityExists(a)).toBe(false);
			expect(world.entityExists(b)).toBe(false);
			expect(world.entityExists(c)).toBe(false);
		});
	});

	describe('dead-entity guards', () => {
		it('throws when addComponent is called on a destroyed entity', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.destroyEntity(e);

			expect(() => world.addComponent(e, Position, { x: 1, y: 2 })).toThrow(
				/does not exist or has been destroyed/,
			);
		});

		it('throws when addComponent is called on a never-created entity', () => {
			const world = createWorld();

			expect(() => world.addComponent(9999, Position, { x: 1, y: 2 })).toThrow(
				/does not exist or has been destroyed/,
			);
		});

		it('throws when addTag is called on a destroyed entity', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.destroyEntity(e);

			expect(() => world.addTag(e, Selected)).toThrow(/does not exist or has been destroyed/);
		});

		it('does not leak phantom entities into queries after a failed write', () => {
			const world = createWorld();
			expect(() => world.addComponent(42, Position, { x: 0, y: 0 })).toThrow();
			expect(world.query(Position)).toEqual([]);
			expect(world.entityExists(42)).toBe(false);
		});
	});

	describe('introspection', () => {
		it('lists all live entities', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			const c = world.createEntity();
			world.destroyEntity(b);

			const all = world.getAllEntities();
			expect(all).toHaveLength(2);
			expect(all).toContain(a);
			expect(all).toContain(c);
			expect(all).not.toContain(b);
		});

		it('lists registered component, tag, and resource types', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			world.addComponent(e, Velocity, { dx: 0, dy: 0 });
			world.addTag(e, Selected);
			world.getResource(Camera);

			expect(
				world
					.getRegisteredComponents()
					.map((t) => t.name)
					.sort(),
			).toEqual(['Position', 'Velocity']);
			expect(world.getRegisteredTags().map((t) => t.name)).toEqual(['Selected']);
			expect(world.getRegisteredResources().map((t) => t.name)).toEqual(['Camera']);
		});

		it('lists components attached to a specific entity', () => {
			const world = createWorld();
			const e1 = world.createEntity();
			const e2 = world.createEntity();
			world.addComponent(e1, Position, { x: 0, y: 0 });
			world.addComponent(e1, Label, { text: 'hi' });
			world.addComponent(e2, Velocity, { dx: 1, dy: 0 });

			expect(
				world
					.getComponentsOf(e1)
					.map((t) => t.name)
					.sort(),
			).toEqual(['Label', 'Position']);
			expect(world.getComponentsOf(e2).map((t) => t.name)).toEqual(['Velocity']);
		});

		it('reflects component removal in getComponentsOf', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			world.addComponent(e, Label, { text: 'hi' });
			world.removeComponent(e, Position);

			expect(world.getComponentsOf(e).map((t) => t.name)).toEqual(['Label']);
		});

		it('lists tags attached to a specific entity', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addTag(e, Selected);
			world.addTag(e, Visible);

			expect(
				world
					.getTagsOf(e)
					.map((t) => t.name)
					.sort(),
			).toEqual(['Selected', 'Visible']);

			world.removeTag(e, Selected);
			expect(world.getTagsOf(e).map((t) => t.name)).toEqual(['Visible']);
		});

		it('fires onEntityCreated after the entity id is live', () => {
			const world = createWorld();
			const seen: number[] = [];
			world.onEntityCreated((id) => {
				// Must be observable as alive at fire-time so listeners can read state
				expect(world.entityExists(id)).toBe(true);
				seen.push(id);
			});

			const a = world.createEntity();
			const b = world.createEntity();
			expect(seen).toEqual([a, b]);
		});

		it('unsubscribes onEntityCreated', () => {
			const world = createWorld();
			const handler = vi.fn();
			const unsub = world.onEntityCreated(handler);
			world.createEntity();
			expect(handler).toHaveBeenCalledTimes(1);
			unsub();
			world.createEntity();
			expect(handler).toHaveBeenCalledTimes(1);
		});
	});

	describe('id-preserving restore', () => {
		it('creates an entity with a chosen id and resumes allocation after it', () => {
			const world = createWorld();
			expect(world.createEntityWithId(5)).toBe(5);
			expect(world.entityExists(5)).toBe(true);
			expect(world.entityCount).toBe(1);
			expect(world.createEntity()).toBe(6);
		});

		it('throws on an already-alive id', () => {
			const world = createWorld();
			const e = world.createEntity();
			expect(() => world.createEntityWithId(e)).toThrow(/already alive/);
		});

		it('throws on an id below the counter — ids are never reused', () => {
			const world = createWorld();
			world.createEntityWithId(5);
			expect(() => world.createEntityWithId(3)).toThrow(/below the counter/);
		});

		it('throws on zero, negative, and non-integer ids', () => {
			const world = createWorld();
			expect(() => world.createEntityWithId(0)).toThrow(/positive integer/);
			expect(() => world.createEntityWithId(-1)).toThrow(/positive integer/);
			expect(() => world.createEntityWithId(1.5)).toThrow(/positive integer/);
		});

		it('fires onEntityCreated with the chosen id', () => {
			const world = createWorld();
			const handler = vi.fn();
			world.onEntityCreated(handler);
			world.createEntityWithId(7);
			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledWith(7);
		});

		it('setNextEntityId moves the counter forward', () => {
			const world = createWorld();
			world.setNextEntityId(100);
			expect(world.createEntity()).toBe(100);
		});

		it('setNextEntityId throws on backward and non-integer values', () => {
			const world = createWorld();
			world.createEntityWithId(10); // counter is now 11
			expect(() => world.setNextEntityId(5)).toThrow(/only moves forward/);
			expect(() => world.setNextEntityId(11.5)).toThrow(/only moves forward/);
		});

		it('a restored counter prevents destroyed ids from being reused', () => {
			// Original session: create 1-3, destroy 2, save the counter (4).
			const original = createWorld();
			original.createEntity();
			const doomed = original.createEntity();
			original.createEntity();
			original.destroyEntity(doomed);
			const savedNextId = 4;

			// Fresh world: restore the survivors ascending, then the counter.
			const restored = createWorld();
			restored.createEntityWithId(1);
			restored.createEntityWithId(3);
			restored.setNextEntityId(savedNextId);

			// Id 2 stays stale forever — the next allocation is 4, never 2.
			expect(restored.createEntity()).toBe(4);
			expect(restored.entityExists(2)).toBe(false);
		});

		it('round-trips a randomly mutated world with zero remapping', () => {
			// Deterministic PRNG (mulberry32) — no Math.random, reproducible runs.
			let seed = 0xdecafbad;
			const rand = () => {
				seed = (seed + 0x6d2b79f5) | 0;
				let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};

			// Build a world with a pseudo-random sequence of mutations.
			const source = createWorld();
			let creates = 0;
			for (let i = 0; i < 200; i++) {
				const roll = rand();
				const live = source.getAllEntities();
				if (roll < 0.35 || live.length === 0) {
					source.createEntity();
					creates++;
				} else if (roll < 0.45) {
					source.destroyEntity(live[Math.floor(rand() * live.length)]);
				} else if (roll < 0.8) {
					const e = live[Math.floor(rand() * live.length)];
					const which = rand();
					if (which < 0.34) {
						source.addComponent(e, Position, { x: Math.floor(rand() * 1000), y: i });
					} else if (which < 0.67) {
						source.addComponent(e, Velocity, { dx: rand(), dy: rand() });
					} else {
						source.addComponent(e, Label, { text: `entity-${e}-step-${i}` });
					}
				} else {
					const e = live[Math.floor(rand() * live.length)];
					source.addTag(e, rand() < 0.5 ? Selected : Visible);
				}
			}
			const savedNextId = creates + 1; // every create came from createEntity()

			// Serialize via the introspection API only.
			const snapshot = source.getAllEntities().map((entity) => ({
				entity,
				components: source.getComponentsOf(entity).map((type) => ({
					type,
					data: JSON.parse(JSON.stringify(source.getComponent(entity, type))) as Record<
						string,
						unknown
					>,
				})),
				tags: source.getTagsOf(entity),
			}));

			// Restore into a fresh world: ascending ids, then replay, then counter.
			const restored = createWorld();
			for (const entry of [...snapshot].sort((a, b) => a.entity - b.entity)) {
				restored.createEntityWithId(entry.entity);
				for (const { type, data } of entry.components) {
					restored.addComponent(entry.entity, type, data);
				}
				for (const tag of entry.tags) {
					restored.addTag(entry.entity, tag);
				}
			}
			restored.setNextEntityId(savedNextId);

			// Every entity id, component value, and tag identical — no remapping.
			expect([...restored.getAllEntities()].sort((a, b) => a - b)).toEqual(
				[...source.getAllEntities()].sort((a, b) => a - b),
			);
			for (const entity of source.getAllEntities()) {
				expect(
					restored
						.getComponentsOf(entity)
						.map((t) => t.name)
						.sort(),
				).toEqual(
					source
						.getComponentsOf(entity)
						.map((t) => t.name)
						.sort(),
				);
				for (const type of source.getComponentsOf(entity)) {
					expect(restored.getComponent(entity, type)).toEqual(source.getComponent(entity, type));
				}
				expect(
					restored
						.getTagsOf(entity)
						.map((t) => t.name)
						.sort(),
				).toEqual(
					source
						.getTagsOf(entity)
						.map((t) => t.name)
						.sort(),
				);
			}
			// The counter survives the round-trip too.
			expect(restored.createEntity()).toBe(source.createEntity());
		});
	});

	describe('resource defaults', () => {
		it('deep-clones nested objects so worlds do not share state via defaults', () => {
			const Config = defineResource('Config', { nested: { count: 0 } });
			const w1 = createWorld();
			const w2 = createWorld();

			w1.getResource(Config).nested.count = 42;
			expect(w2.getResource(Config).nested.count).toBe(0);
		});

		it('deep-clones nested arrays', () => {
			const Config = defineResource('WithArray', { tags: ['a', 'b'] });
			const w1 = createWorld();
			const w2 = createWorld();

			w1.getResource(Config).tags.push('c');
			expect(w2.getResource(Config).tags).toEqual(['a', 'b']);
		});
	});

	describe('write aliasing', () => {
		it('patchComponent clones incoming plain data — caller aliases cannot mutate world state', () => {
			const Box = defineComponent('AliasBox', { inner: { v: 0 }, list: [0] });
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Box);
			const inner = { v: 99 };
			const data = { inner, list: [1, 2] };
			world.patchComponent(e, Box, data);
			inner.v = 123;
			data.list.push(3);
			expect(world.getComponent(e, Box)).toEqual({ inner: { v: 99 }, list: [1, 2] });
		});

		it('setResource clones incoming plain data — caller aliases cannot mutate world state', () => {
			const Cfg = defineResource('AliasConfig', { opts: { darkMode: false } });
			const world = createWorld();
			const opts = { darkMode: true };
			world.setResource(Cfg, { opts });
			opts.darkMode = false;
			expect(world.getResource(Cfg).opts.darkMode).toBe(true);
		});

		it('patchComponent prev snapshot does not alias next at the top level', () => {
			const Box = defineComponent('AliasBox2', { v: 0 });
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Box);
			let captured: { prev?: unknown; next?: unknown } = {};
			world.onComponentChanged(Box, (_id, prev, next) => {
				captured = { prev, next };
			});
			world.patchComponent(e, Box, { v: 1 });
			expect(captured.prev).not.toBe(captured.next);
			expect(captured.prev).toEqual({ v: 0 });
			expect(captured.next).toEqual({ v: 1 });
		});
	});
});
