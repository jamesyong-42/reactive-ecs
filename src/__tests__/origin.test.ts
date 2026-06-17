import { describe, expect, it } from 'vitest';
import { defineComponent, defineRelation, defineTag } from '../define.js';
import { createWorld } from '../world.js';

const Position = defineComponent('Position', { x: 0, y: 0 });
const Selected = defineTag('Selected');
// Cascade destroys the SOURCE when the TARGET dies — chrome --Owns--> widget,
// destroying the widget tears down the chrome too.
const Owns = defineRelation('Owns', { onTargetDestroy: 'cascade' });

const REMOTE = Symbol('remote');
const UNDO = Symbol('undo-replay');

describe('Origin-tagged mutations (RFC-003)', () => {
	describe('default', () => {
		it('mutationOrigin is undefined outside any window', () => {
			const world = createWorld();
			expect(world.mutationOrigin).toBeUndefined();
		});

		it('a handler fired by a bare updateComponent reads undefined', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			const seen: (string | symbol | undefined)[] = [];
			world.onComponentChanged(Position, () => seen.push(world.mutationOrigin));
			world.updateComponent(e, Position, (p) => ({ ...p, x: 1 }));
			expect(seen).toEqual([undefined]);
		});
	});

	describe('tagging', () => {
		it('onComponentChanged reads the origin — add and set paths, per-entity and wildcard', () => {
			const world = createWorld();
			const e = world.createEntity();
			const wildcard: (string | symbol | undefined)[] = [];
			const perEntity: (string | symbol | undefined)[] = [];
			world.onComponentChanged(Position, () => wildcard.push(world.mutationOrigin));
			world.onComponentChanged(Position, () => perEntity.push(world.mutationOrigin), e);

			world.withOrigin(REMOTE, () => {
				world.addComponent(e, Position, { x: 0, y: 0 }); // add path
				world.updateComponent(e, Position, (p) => ({ ...p, x: 5 })); // set path
			});
			expect(wildcard).toEqual([REMOTE, REMOTE]);
			expect(perEntity).toEqual([REMOTE, REMOTE]);
		});

		it('onComponentRemoved reads the origin — per-entity and wildcard', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			const seen: (string | symbol | undefined)[] = [];
			world.onComponentRemoved(Position, () => seen.push(world.mutationOrigin));
			world.onComponentRemoved(Position, () => seen.push(world.mutationOrigin), e);

			world.withOrigin(REMOTE, () => world.removeComponent(e, Position));
			expect(seen).toEqual([REMOTE, REMOTE]);
		});

		it('onTagAdded and onTagRemoved read the origin — per-entity and wildcard', () => {
			const world = createWorld();
			const e = world.createEntity();
			const added: (string | symbol | undefined)[] = [];
			const removed: (string | symbol | undefined)[] = [];
			world.onTagAdded(Selected, () => added.push(world.mutationOrigin));
			world.onTagAdded(Selected, () => added.push(world.mutationOrigin), e);
			world.onTagRemoved(Selected, () => removed.push(world.mutationOrigin));
			world.onTagRemoved(Selected, () => removed.push(world.mutationOrigin), e);

			world.withOrigin(REMOTE, () => {
				world.addTag(e, Selected);
				world.removeTag(e, Selected);
			});
			expect(added).toEqual([REMOTE, REMOTE]);
			expect(removed).toEqual([REMOTE, REMOTE]);
		});

		it('onEntityCreated and onEntityDestroyed read the origin', () => {
			const world = createWorld();
			const seen: (string | symbol | undefined)[] = [];
			world.onEntityCreated(() => seen.push(world.mutationOrigin));
			world.onEntityDestroyed(() => seen.push(world.mutationOrigin));

			const e = world.withOrigin(REMOTE, () => world.createEntity());
			world.withOrigin(REMOTE, () => world.destroyEntity(e));
			expect(seen).toEqual([REMOTE, REMOTE]);
		});

		it('string origins work too', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			const seen: (string | symbol | undefined)[] = [];
			world.onComponentChanged(Position, () => seen.push(world.mutationOrigin));
			world.withOrigin('peer-42', () =>
				world.updateComponent(e, Position, (p) => ({ ...p, x: 1 })),
			);
			expect(seen).toEqual(['peer-42']);
		});
	});

	describe('nesting', () => {
		it('innermost origin wins; exiting restores the enclosing one, then undefined', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			const seen: (string | symbol | undefined)[] = [];
			world.onComponentChanged(Position, () => seen.push(world.mutationOrigin));

			world.withOrigin(REMOTE, () => {
				world.withOrigin(UNDO, () => world.updateComponent(e, Position, (p) => ({ ...p, x: 1 })));
				// After inner exit, mutations read the enclosing origin.
				world.updateComponent(e, Position, (p) => ({ ...p, x: 2 }));
			});
			// After outer exit, back to undefined.
			world.updateComponent(e, Position, (p) => ({ ...p, x: 3 }));

			expect(seen).toEqual([UNDO, REMOTE, undefined]);
		});
	});

	describe('exception safety', () => {
		it('restores the origin when fn throws', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			const seen: (string | symbol | undefined)[] = [];
			world.onComponentChanged(Position, () => seen.push(world.mutationOrigin));

			expect(() =>
				world.withOrigin(REMOTE, () => {
					world.withOrigin(UNDO, () => {
						throw new Error('boom');
					});
				}),
			).toThrow('boom');
			expect(world.mutationOrigin).toBeUndefined();

			// Subsequent mutations read the restored (no-window) value.
			world.updateComponent(e, Position, (p) => ({ ...p, x: 1 }));
			expect(seen).toEqual([undefined]);
		});

		it('restores the ENCLOSING origin when an inner fn throws', () => {
			const world = createWorld();
			const seen: (string | symbol | undefined)[] = [];
			world.withOrigin(REMOTE, () => {
				try {
					world.withOrigin(UNDO, () => {
						throw new Error('boom');
					});
				} catch {
					// swallowed — the enclosing window must still be intact
				}
				seen.push(world.mutationOrigin);
			});
			expect(seen).toEqual([REMOTE]);
		});
	});

	describe('return passthrough', () => {
		it('returns fn’s return value', () => {
			const world = createWorld();
			expect(world.withOrigin(REMOTE, () => 42)).toBe(42);
		});
	});

	describe('destroy inheritance', () => {
		it('destroyEntity teardown handlers all read the call-site origin', () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			world.addTag(e, Selected);
			const seen: (string | symbol | undefined)[] = [];
			world.onComponentRemoved(Position, () => seen.push(world.mutationOrigin));
			world.onTagRemoved(Selected, () => seen.push(world.mutationOrigin));
			world.onEntityDestroyed(() => seen.push(world.mutationOrigin));

			world.withOrigin(REMOTE, () => world.destroyEntity(e));
			// destroy listener, component removed, tag removed — all REMOTE
			expect(seen).toEqual([REMOTE, REMOTE, REMOTE]);
		});

		it('relation cascade-destroys inherit the origin too', () => {
			const world = createWorld();
			const widget = world.createEntity();
			const chrome = world.createEntity();
			world.addComponent(chrome, Position, { x: 0, y: 0 });
			world.addTag(chrome, Selected);
			world.relate(chrome, Owns, widget);

			const destroyed: [number, string | symbol | undefined][] = [];
			const componentRemovals: (string | symbol | undefined)[] = [];
			const tagRemovals: (string | symbol | undefined)[] = [];
			const edgeRemovals: (string | symbol | undefined)[] = [];
			world.onEntityDestroyed((id) => destroyed.push([id, world.mutationOrigin]));
			world.onComponentRemoved(Position, () => componentRemovals.push(world.mutationOrigin));
			world.onTagRemoved(Selected, () => tagRemovals.push(world.mutationOrigin));
			world.onRelationRemoved(Owns, () => edgeRemovals.push(world.mutationOrigin));

			// Destroying the TARGET cascade-destroys the SOURCE (chrome).
			world.withOrigin(REMOTE, () => world.destroyEntity(widget));

			expect(destroyed).toEqual([
				[widget, REMOTE],
				[chrome, REMOTE],
			]);
			// Fired during the cascade-destroyed chrome's teardown.
			expect(componentRemovals).toEqual([REMOTE]);
			expect(tagRemovals).toEqual([REMOTE]);
			// The swept edge's removal handler reads the origin too.
			expect(edgeRemovals).toEqual([REMOTE]);
			expect(world.entityExists(chrome)).toBe(false);
		});
	});

	describe('validation', () => {
		it('throws for a non-string, non-symbol origin', () => {
			const world = createWorld();
			expect(() => world.withOrigin(42 as never, () => {})).toThrow(
				/origin must be a string or symbol/,
			);
		});

		it('throws for undefined — "no origin" is unforgeable', () => {
			const world = createWorld();
			expect(() => world.withOrigin(undefined as never, () => {})).toThrow(
				/origin must be a string or symbol/,
			);
		});
	});

	describe('async boundary (documenting)', () => {
		it('an async fn’s post-await mutation reads undefined — the window is synchronous', async () => {
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, Position, { x: 0, y: 0 });
			const seen: (string | symbol | undefined)[] = [];
			world.onComponentChanged(Position, () => seen.push(world.mutationOrigin));

			await world.withOrigin(REMOTE, async () => {
				world.updateComponent(e, Position, (p) => ({ ...p, x: 1 })); // pre-await: tagged
				await Promise.resolve();
				world.updateComponent(e, Position, (p) => ({ ...p, x: 2 })); // post-await: NOT tagged
			});

			expect(seen).toEqual([REMOTE, undefined]);
		});
	});
});
