import { describe, expect, it, vi } from 'vitest';
import { defineComponent, defineRelation, defineTag } from '../define.js';
import { createWorld } from '../world.js';

const Position = defineComponent('Position', { x: 0, y: 0 });
const Cancelled = defineTag('Cancelled');

// Fresh relation types per concern — relations are world-agnostic identities
// like components and tags, so sharing across tests is safe.
const Likes = defineRelation('Likes');
const ChildOf = defineRelation('ChildOf', { sourceExclusive: true });
const Owns = defineRelation('Owns', { targetExclusive: true });
const Dragging = defineRelation('Dragging', { sourceExclusive: true, targetExclusive: true });
const Anchored = defineRelation('Anchored', { onTargetDestroy: 'cascade' });
const Watches = defineRelation('Watches', { onTargetDestroy: { tag: Cancelled } });

describe('Relations', () => {
	describe('relate / unrelate basics', () => {
		it('relates entities and keeps getTargets/getTarget/getSources coherent', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			const c = world.createEntity();

			world.relate(a, Likes, b);
			world.relate(a, Likes, c);
			world.relate(c, Likes, b);

			expect(world.getTargets(a, Likes).sort()).toEqual([b, c].sort());
			expect(world.getTarget(c, Likes)).toBe(b);
			expect(world.getSources(Likes, b).sort()).toEqual([a, c].sort());
			expect(world.getSources(Likes, c)).toEqual([a]);
		});

		it('returns empty/undefined for entities with no edges', () => {
			const world = createWorld();
			const e = world.createEntity();
			expect(world.getTargets(e, Likes)).toEqual([]);
			expect(world.getTarget(e, Likes)).toBeUndefined();
			expect(world.getSources(Likes, e)).toEqual([]);
		});

		it('maintains the inverse on unrelate', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.relate(a, Likes, b);
			world.unrelate(a, Likes, b);
			expect(world.getTargets(a, Likes)).toEqual([]);
			expect(world.getSources(Likes, b)).toEqual([]);
		});

		it('relate of an existing edge is a no-op — no duplicate events or buffer entries', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			const handler = vi.fn();
			world.onRelationAdded(Likes, handler);

			world.relate(a, Likes, b);
			world.relate(a, Likes, b);
			expect(handler).toHaveBeenCalledTimes(1);
			expect(world.queryRelationAdded(Likes)).toEqual([[a, b]]);
			expect(world.getTargets(a, Likes)).toEqual([b]);
		});

		it('unrelate of an absent edge is a no-op', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.unrelate(a, Likes, b);
			world.unrelate(a, Likes);
			expect(world.queryRelationRemoved(Likes)).toEqual([]);
		});

		it('unrelate with target omitted removes ALL of the source outgoing edges', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			const c = world.createEntity();
			world.relate(a, Likes, b);
			world.relate(a, Likes, c);
			world.clearDirty();

			world.unrelate(a, Likes);
			expect(world.getTargets(a, Likes)).toEqual([]);
			expect(world.getSources(Likes, b)).toEqual([]);
			expect(world.getSources(Likes, c)).toEqual([]);
			expect(world.queryRelationRemoved(Likes).sort()).toEqual(
				[
					[a, b],
					[a, c],
				].sort(),
			);
		});

		it('throws when relate is called with a dead source', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.destroyEntity(a);
			expect(() => world.relate(a, Likes, b)).toThrow(/does not exist or has been destroyed/);
		});

		it('throws when relate is called with a dead target', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.destroyEntity(b);
			expect(() => world.relate(a, Likes, b)).toThrow(/does not exist or has been destroyed/);
		});

		it('throws when two different RelationTypes share a name', () => {
			const A = defineRelation('DupeRel');
			const B = defineRelation('DupeRel');
			const world = createWorld();
			const e = world.createEntity();

			world.getTargets(e, A);
			expect(() => world.getTargets(e, B)).toThrow(/Relation name collision/i);
		});
	});

	describe('exclusivity', () => {
		it('sourceExclusive replacement emits removed(s, t1) then added(s, t2)', () => {
			const world = createWorld();
			const child = world.createEntity();
			const p1 = world.createEntity();
			const p2 = world.createEntity();
			world.relate(child, ChildOf, p1);
			world.clearDirty();

			const order: string[] = [];
			world.onRelationRemoved(ChildOf, (s, t) => order.push(`removed:${s}->${t}`));
			world.onRelationAdded(ChildOf, (s, t) => order.push(`added:${s}->${t}`));

			world.relate(child, ChildOf, p2);
			expect(order).toEqual([`removed:${child}->${p1}`, `added:${child}->${p2}`]);
			expect(world.getTargets(child, ChildOf)).toEqual([p2]);
			expect(world.getSources(ChildOf, p1)).toEqual([]);
			// Buffers reflect both sides of the replacement.
			expect(world.queryRelationRemoved(ChildOf)).toEqual([[child, p1]]);
			expect(world.queryRelationAdded(ChildOf)).toEqual([[child, p2]]);
		});

		it('targetExclusive replacement displaces the prior source', () => {
			const world = createWorld();
			const o1 = world.createEntity();
			const o2 = world.createEntity();
			const item = world.createEntity();
			world.relate(o1, Owns, item);
			world.clearDirty();

			const order: string[] = [];
			world.onRelationRemoved(Owns, (s, t) => order.push(`removed:${s}->${t}`));
			world.onRelationAdded(Owns, (s, t) => order.push(`added:${s}->${t}`));

			world.relate(o2, Owns, item);
			expect(order).toEqual([`removed:${o1}->${item}`, `added:${o2}->${item}`]);
			expect(world.getSources(Owns, item)).toEqual([o2]);
			expect(world.getTargets(o1, Owns)).toEqual([]);
			expect(world.queryRelationRemoved(Owns)).toEqual([[o1, item]]);
			expect(world.queryRelationAdded(Owns)).toEqual([[o2, item]]);
		});

		it('both-exclusive relation is a true 1:1', () => {
			const world = createWorld();
			const pointer1 = world.createEntity();
			const pointer2 = world.createEntity();
			const widget1 = world.createEntity();
			const widget2 = world.createEntity();

			world.relate(pointer1, Dragging, widget1);
			// A second pointer cannot seize the widget — the first edge is replaced.
			world.relate(pointer2, Dragging, widget1);
			expect(world.getTargets(pointer1, Dragging)).toEqual([]);
			expect(world.getSources(Dragging, widget1)).toEqual([pointer2]);

			// The pointer cannot drag two widgets either.
			world.relate(pointer2, Dragging, widget2);
			expect(world.getSources(Dragging, widget1)).toEqual([]);
			expect(world.getTargets(pointer2, Dragging)).toEqual([widget2]);
		});
	});

	describe('per-tick buffers', () => {
		it('queryRelation returns all live edges', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			const c = world.createEntity();
			world.relate(a, Likes, b);
			world.relate(b, Likes, c);

			expect(world.queryRelation(Likes).sort()).toEqual(
				[
					[a, b],
					[b, c],
				].sort(),
			);
		});

		it('queryRelationAdded populates and is cleared by clearDirty', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.relate(a, Likes, b);
			expect(world.queryRelationAdded(Likes)).toEqual([[a, b]]);
			world.clearDirty();
			expect(world.queryRelationAdded(Likes)).toEqual([]);
			// The live edge is unaffected by the buffer clear.
			expect(world.queryRelation(Likes)).toEqual([[a, b]]);
		});

		it('queryRelationRemoved populates and is cleared by clearDirty', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.relate(a, Likes, b);
			world.clearDirty();
			world.unrelate(a, Likes, b);
			expect(world.queryRelationRemoved(Likes)).toEqual([[a, b]]);
			world.clearDirty();
			expect(world.queryRelationRemoved(Likes)).toEqual([]);
		});

		it('queryRelationRemoved net-cancels with relate in the same tick', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.relate(a, Likes, b);
			world.clearDirty();

			// unrelate then relate → the edge is in `added` but NOT in `removed`
			world.unrelate(a, Likes, b);
			expect(world.queryRelationRemoved(Likes)).toEqual([[a, b]]);
			world.relate(a, Likes, b);
			expect(world.queryRelationRemoved(Likes)).toEqual([]);
			expect(world.queryRelationAdded(Likes)).toEqual([[a, b]]);
		});

		it('queryRelationAdded net-cancels with unrelate in the same tick', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			// relate then unrelate (no prior state) → added empty, removed has the edge
			world.relate(a, Likes, b);
			expect(world.queryRelationAdded(Likes)).toEqual([[a, b]]);
			world.unrelate(a, Likes, b);
			expect(world.queryRelationAdded(Likes)).toEqual([]);
			expect(world.queryRelationRemoved(Likes)).toEqual([[a, b]]);
		});
	});

	describe('observers', () => {
		it('fires relation added/removed events with source and target', () => {
			const world = createWorld();
			const added = vi.fn();
			const removed = vi.fn();
			world.onRelationAdded(Likes, added);
			world.onRelationRemoved(Likes, removed);

			const a = world.createEntity();
			const b = world.createEntity();
			world.relate(a, Likes, b);
			expect(added).toHaveBeenCalledWith(a, b);

			world.unrelate(a, Likes, b);
			expect(removed).toHaveBeenCalledWith(a, b);
		});

		it('per-source filter only fires for that source', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			const c = world.createEntity();

			const handler = vi.fn();
			world.onRelationAdded(Likes, handler, a);
			world.relate(b, Likes, c);
			expect(handler).not.toHaveBeenCalled();
			world.relate(a, Likes, c);
			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledWith(a, c);
		});

		it('fires per-source handler before wildcard', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();

			const order: string[] = [];
			world.onRelationAdded(Likes, () => order.push('wildcard'));
			world.onRelationAdded(Likes, () => order.push('source'), a);
			world.relate(a, Likes, b);
			expect(order).toEqual(['source', 'wildcard']);
		});

		it('unsubscribes handlers', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();

			const handler = vi.fn();
			const unsub = world.onRelationRemoved(Likes, handler);
			unsub();
			world.relate(a, Likes, b);
			world.unrelate(a, Likes, b);
			expect(handler).not.toHaveBeenCalled();
		});
	});

	describe('entity destruction', () => {
		it('source death removes its outgoing edges with events and buffers', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.relate(a, Likes, b);
			world.clearDirty();

			const removed = vi.fn();
			world.onRelationRemoved(Likes, removed);
			world.destroyEntity(a);
			expect(removed).toHaveBeenCalledWith(a, b);
			expect(world.queryRelationRemoved(Likes)).toEqual([[a, b]]);
			expect(world.getSources(Likes, b)).toEqual([]);
		});

		it("target death with 'clear' drops the edge and leaves the source alive", () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.relate(a, Likes, b);
			world.clearDirty();

			world.destroyEntity(b);
			expect(world.entityExists(a)).toBe(true);
			expect(world.getTargets(a, Likes)).toEqual([]);
			expect(world.queryRelationRemoved(Likes)).toEqual([[a, b]]);
		});

		it("target death with 'cascade' destroys the source too", () => {
			const world = createWorld();
			const chrome = world.createEntity();
			const target = world.createEntity();
			world.relate(chrome, Anchored, target);

			world.destroyEntity(target);
			expect(world.entityExists(chrome)).toBe(false);
			expect(world.queryRelation(Anchored)).toEqual([]);
		});

		it('target death with { tag } adds the tag to each source', () => {
			const world = createWorld();
			const r1 = world.createEntity();
			const r2 = world.createEntity();
			const pointer = world.createEntity();
			world.relate(r1, Watches, pointer);
			world.relate(r2, Watches, pointer);

			world.destroyEntity(pointer);
			expect(world.entityExists(r1)).toBe(true);
			expect(world.hasTag(r1, Cancelled)).toBe(true);
			expect(world.hasTag(r2, Cancelled)).toBe(true);
		});

		it('cascade chain across A→B→C terminates and destroys the whole chain', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			const c = world.createEntity();
			world.relate(a, Anchored, b);
			world.relate(b, Anchored, c);

			world.destroyEntity(c);
			expect(world.entityExists(b)).toBe(false);
			expect(world.entityExists(a)).toBe(false);
		});

		it('cyclic cascade (A targets B, B targets A) terminates', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.relate(a, Anchored, b);
			world.relate(b, Anchored, a);

			world.destroyEntity(b);
			expect(world.entityExists(a)).toBe(false);
			expect(world.entityExists(b)).toBe(false);
			expect(world.queryRelation(Anchored)).toEqual([]);
		});

		it('{ tag } effect is skipped when a prior cascade destroyed the source', () => {
			const world = createWorld();
			const source = world.createEntity();
			const target = world.createEntity();
			// Anchored's store is created first, so its cascade effect is
			// collected (and applied) before Watches' tag effect.
			world.relate(source, Anchored, target);
			world.relate(source, Watches, target);

			// If the tag effect were not skipped, addTag on the dead source
			// would throw.
			expect(() => world.destroyEntity(target)).not.toThrow();
			expect(world.entityExists(source)).toBe(false);
		});

		it('onRelationRemoved fired during a destroy can still read the dying entity components', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			world.addComponent(b, Position, { x: 7, y: 9 });
			world.relate(a, Likes, b);

			let seen: { x: number; y: number } | undefined;
			world.onRelationRemoved(Likes, (_source, target) => {
				seen = world.getComponent(target, Position);
			});

			world.destroyEntity(b);
			expect(seen).toEqual({ x: 7, y: 9 });
		});

		it('destroy-driven removals appear in queryRelationRemoved for both roles', () => {
			const world = createWorld();
			const a = world.createEntity();
			const b = world.createEntity();
			const c = world.createEntity();
			world.relate(b, Likes, c); // b as source
			world.relate(a, Likes, b); // b as target
			world.clearDirty();

			world.destroyEntity(b);
			expect(world.queryRelationRemoved(Likes).sort()).toEqual(
				[
					[a, b],
					[b, c],
				].sort(),
			);
		});
	});
});
