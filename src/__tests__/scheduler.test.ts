import { describe, expect, it } from 'vitest';
import { defineComponent, defineSystem } from '../define.js';
import { SystemScheduler } from '../scheduler.js';
import { createWorld } from '../world.js';

describe('SystemScheduler', () => {
	it('executes systems in registration order when no constraints', () => {
		const order: string[] = [];
		const scheduler = new SystemScheduler();
		const world = createWorld();

		scheduler.register(defineSystem({ name: 'a', execute: () => order.push('a') }));
		scheduler.register(defineSystem({ name: 'b', execute: () => order.push('b') }));
		scheduler.register(defineSystem({ name: 'c', execute: () => order.push('c') }));

		scheduler.execute(world);
		expect(order).toEqual(['a', 'b', 'c']);
	});

	it('respects after constraints', () => {
		const order: string[] = [];
		const scheduler = new SystemScheduler();
		const world = createWorld();

		scheduler.register(
			defineSystem({ name: 'render', after: 'physics', execute: () => order.push('render') }),
		);
		scheduler.register(defineSystem({ name: 'physics', execute: () => order.push('physics') }));
		scheduler.register(defineSystem({ name: 'input', execute: () => order.push('input') }));

		scheduler.execute(world);
		const physicsIdx = order.indexOf('physics');
		const renderIdx = order.indexOf('render');
		expect(physicsIdx).toBeLessThan(renderIdx);
	});

	it('respects before constraints', () => {
		const order: string[] = [];
		const scheduler = new SystemScheduler();
		const world = createWorld();

		scheduler.register(defineSystem({ name: 'a', execute: () => order.push('a') }));
		scheduler.register(defineSystem({ name: 'b', before: 'a', execute: () => order.push('b') }));

		scheduler.execute(world);
		expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
	});

	it('handles chain: a -> b -> c', () => {
		const order: string[] = [];
		const scheduler = new SystemScheduler();
		const world = createWorld();

		scheduler.register(defineSystem({ name: 'c', after: 'b', execute: () => order.push('c') }));
		scheduler.register(defineSystem({ name: 'a', execute: () => order.push('a') }));
		scheduler.register(defineSystem({ name: 'b', after: 'a', execute: () => order.push('b') }));

		scheduler.execute(world);
		expect(order).toEqual(['a', 'b', 'c']);
	});

	it('detects circular dependencies', () => {
		const scheduler = new SystemScheduler();

		scheduler.register(defineSystem({ name: 'a', after: 'b', execute: () => {} }));
		scheduler.register(defineSystem({ name: 'b', after: 'a', execute: () => {} }));

		expect(() => scheduler.getSystemNames()).toThrow(/circular/i);
	});

	it('removes systems', () => {
		const order: string[] = [];
		const scheduler = new SystemScheduler();
		const world = createWorld();

		scheduler.register(defineSystem({ name: 'a', execute: () => order.push('a') }));
		scheduler.register(defineSystem({ name: 'b', execute: () => order.push('b') }));

		scheduler.remove('a');
		scheduler.execute(world);
		expect(order).toEqual(['b']);
	});

	it('replaces system with same name', () => {
		const order: string[] = [];
		const scheduler = new SystemScheduler();
		const world = createWorld();

		scheduler.register(defineSystem({ name: 'a', execute: () => order.push('a1') }));
		scheduler.register(defineSystem({ name: 'a', execute: () => order.push('a2') }));

		scheduler.execute(world);
		expect(order).toEqual(['a2']);
	});

	it('ignores after/before referencing non-existent systems', () => {
		const order: string[] = [];
		const scheduler = new SystemScheduler();
		const world = createWorld();

		scheduler.register(
			defineSystem({ name: 'a', after: 'nonexistent', execute: () => order.push('a') }),
		);

		scheduler.execute(world);
		expect(order).toEqual(['a']);
	});

	it('ignores duplicate dependencies instead of reporting a false cycle', () => {
		// after: ['a', 'a'] previously double-counted inDegree and reported a cycle.
		const scheduler = new SystemScheduler();
		const world = createWorld();
		const order: string[] = [];

		scheduler.register(defineSystem({ name: 'a', execute: () => order.push('a') }));
		scheduler.register(
			defineSystem({ name: 'b', after: ['a', 'a'], execute: () => order.push('b') }),
		);

		expect(() => scheduler.getSystemNames()).not.toThrow();
		scheduler.execute(world);
		expect(order).toEqual(['a', 'b']);
	});

	it('invokes the attached SystemProfiler around each system', () => {
		const calls: string[] = [];
		const scheduler = new SystemScheduler();
		const world = createWorld();

		scheduler.profiler = {
			beginSystem: (name) => calls.push(`begin:${name}`),
			endSystem: (name) => calls.push(`end:${name}`),
		};

		scheduler.register(defineSystem({ name: 'a', execute: () => calls.push('run:a') }));
		scheduler.register(defineSystem({ name: 'b', execute: () => calls.push('run:b') }));

		scheduler.execute(world);
		expect(calls).toEqual(['begin:a', 'run:a', 'end:a', 'begin:b', 'run:b', 'end:b']);
	});

	describe('runIf', () => {
		it('skips the system when runIf returns false, runs it when true', () => {
			const order: string[] = [];
			const scheduler = new SystemScheduler();
			const world = createWorld();

			scheduler.register(
				defineSystem({ name: 'skipped', runIf: () => false, execute: () => order.push('skipped') }),
			);
			scheduler.register(
				defineSystem({ name: 'guarded', runIf: () => true, execute: () => order.push('guarded') }),
			);
			scheduler.register(
				defineSystem({ name: 'unguarded', execute: () => order.push('unguarded') }),
			);

			scheduler.execute(world);
			expect(order).toEqual(['guarded', 'unguarded']);
		});

		it('passes the world given to execute() into the predicate', () => {
			const scheduler = new SystemScheduler();
			const world = createWorld();
			let seen: unknown;

			scheduler.register(
				defineSystem({
					name: 'a',
					runIf: (w) => {
						seen = w;
						return true;
					},
					execute: () => {},
				}),
			);

			scheduler.execute(world);
			expect(seen).toBe(world);
		});

		it('re-evaluates the predicate every execute() call', () => {
			const order: string[] = [];
			const scheduler = new SystemScheduler();
			const world = createWorld();
			let enabled = false;

			scheduler.register(
				defineSystem({ name: 'a', runIf: () => enabled, execute: () => order.push('a') }),
			);

			scheduler.execute(world);
			enabled = true;
			scheduler.execute(world);
			enabled = false;
			scheduler.execute(world);
			expect(order).toEqual(['a']);
		});

		it('calls skipSystem on skip — beginSystem/endSystem only on a run', () => {
			const calls: string[] = [];
			const scheduler = new SystemScheduler();
			const world = createWorld();
			let enabled = false;

			scheduler.profiler = {
				beginSystem: (name) => calls.push(`begin:${name}`),
				endSystem: (name) => calls.push(`end:${name}`),
				skipSystem: (name) => calls.push(`skip:${name}`),
			};

			scheduler.register(
				defineSystem({ name: 'a', runIf: () => enabled, execute: () => calls.push('run:a') }),
			);

			scheduler.execute(world);
			expect(calls).toEqual(['skip:a']);

			calls.length = 0;
			enabled = true;
			scheduler.execute(world);
			expect(calls).toEqual(['begin:a', 'run:a', 'end:a']);
		});

		it('tolerates profilers without skipSystem', () => {
			const calls: string[] = [];
			const scheduler = new SystemScheduler();
			const world = createWorld();

			scheduler.profiler = {
				beginSystem: (name) => calls.push(`begin:${name}`),
				endSystem: (name) => calls.push(`end:${name}`),
			};

			scheduler.register(defineSystem({ name: 'a', runIf: () => false, execute: () => {} }));

			expect(() => scheduler.execute(world)).not.toThrow();
			expect(calls).toEqual([]);
		});

		it('does not disturb the topo order of the other systems when one skips', () => {
			const order: string[] = [];
			const scheduler = new SystemScheduler();
			const world = createWorld();

			scheduler.register(defineSystem({ name: 'a', execute: () => order.push('a') }));
			scheduler.register(
				defineSystem({ name: 'b', after: 'a', runIf: () => false, execute: () => order.push('b') }),
			);
			scheduler.register(defineSystem({ name: 'c', after: 'b', execute: () => order.push('c') }));

			scheduler.execute(world);
			expect(order).toEqual(['a', 'c']);
		});

		it('guards on queryChanged — runs only on ticks where the component changed', () => {
			const C = defineComponent<{ v: number }>('C', { v: 0 });
			const runs: number[] = [];
			let tick = 0;
			const scheduler = new SystemScheduler();
			const world = createWorld();
			const e = world.createEntity();
			world.addComponent(e, C, { v: 0 });
			world.clearDirty();

			scheduler.register(
				defineSystem({
					name: 'lazy',
					runIf: (w) => w.queryChanged(C).length > 0,
					execute: () => runs.push(tick),
				}),
			);

			// Tick 0: C changed this tick → runs.
			tick = 0;
			world.patchComponent(e, C, { v: 1 });
			scheduler.execute(world);
			world.clearDirty();

			// Tick 1: nothing changed → skipped.
			tick = 1;
			scheduler.execute(world);
			world.clearDirty();

			// Tick 2: C changed again → runs.
			tick = 2;
			world.patchComponent(e, C, { v: 2 });
			scheduler.execute(world);
			world.clearDirty();

			expect(runs).toEqual([0, 2]);
		});
	});
});
