import { describe, expect, it } from 'vitest';
import { defineSystem } from '../define.js';
import { PhasedScheduler, type SystemProfiler } from '../scheduler.js';
import { createWorld } from '../world.js';

// A representative phase set for tests. The library no longer ships a default
// vocabulary — these names are local to each test scope.
const TEST_PHASES = ['input', 'react', 'control', 'derive', 'cleanup'] as const;

describe('PhasedScheduler', () => {
	describe('constructor', () => {
		it('throws when phases is empty', () => {
			expect(() => new PhasedScheduler({ phases: [] })).toThrow(/at least one phase/);
		});

		it('throws on duplicate phases', () => {
			expect(() => new PhasedScheduler({ phases: ['a', 'b', 'a'] })).toThrow(/duplicate phase 'a'/);
		});

		it('throws when defaultPhase is not in phases', () => {
			expect(
				() => new PhasedScheduler({ phases: ['a', 'b'] as const, defaultPhase: 'c' as 'a' | 'b' }),
			).toThrow(/defaultPhase 'c' is not in phases/);
		});
	});

	describe('execution order', () => {
		it('runs phases in the configured order regardless of registration order', () => {
			const order: string[] = [];
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(
				defineSystem({ name: 'cleanupA', phase: 'cleanup', execute: () => order.push('cleanup') }),
			);
			scheduler.register(
				defineSystem({ name: 'inputA', phase: 'input', execute: () => order.push('input') }),
			);
			scheduler.register(
				defineSystem({ name: 'reactA', phase: 'react', execute: () => order.push('react') }),
			);
			scheduler.register(
				defineSystem({ name: 'deriveA', phase: 'derive', execute: () => order.push('derive') }),
			);

			scheduler.execute(world);
			expect(order).toEqual(['input', 'react', 'derive', 'cleanup']);
		});

		it('respects within-phase after constraints', () => {
			const order: string[] = [];
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(
				defineSystem({ name: 'b', phase: 'react', after: 'a', execute: () => order.push('b') }),
			);
			scheduler.register(
				defineSystem({ name: 'a', phase: 'react', execute: () => order.push('a') }),
			);

			scheduler.execute(world);
			expect(order).toEqual(['a', 'b']);
		});

		it('respects within-phase before constraints', () => {
			const order: string[] = [];
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(
				defineSystem({ name: 'a', phase: 'derive', execute: () => order.push('a') }),
			);
			scheduler.register(
				defineSystem({
					name: 'b',
					phase: 'derive',
					before: 'a',
					execute: () => order.push('b'),
				}),
			);

			scheduler.execute(world);
			expect(order).toEqual(['b', 'a']);
		});

		it('allows after pointing at an earlier phase (harmless, phase order already enforces)', () => {
			const order: string[] = [];
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(
				defineSystem({ name: 'reactA', phase: 'react', execute: () => order.push('reactA') }),
			);
			scheduler.register(
				defineSystem({
					name: 'deriveB',
					phase: 'derive',
					after: 'reactA',
					execute: () => order.push('deriveB'),
				}),
			);

			expect(() => scheduler.execute(world)).not.toThrow();
			expect(order).toEqual(['reactA', 'deriveB']);
		});

		it('throws when after points at a later-phase system', () => {
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(defineSystem({ name: 'deriveA', phase: 'derive', execute: () => {} }));
			scheduler.register(
				defineSystem({
					name: 'reactA',
					phase: 'react',
					after: 'deriveA',
					execute: () => {},
				}),
			);

			expect(() => scheduler.execute(world)).toThrow(
				/reactA.*after.*deriveA.*later phase 'derive'/,
			);
		});

		it('throws when before points at an earlier-phase system', () => {
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(defineSystem({ name: 'reactA', phase: 'react', execute: () => {} }));
			scheduler.register(
				defineSystem({
					name: 'deriveA',
					phase: 'derive',
					before: 'reactA',
					execute: () => {},
				}),
			);

			expect(() => scheduler.execute(world)).toThrow(
				/deriveA.*before.*reactA.*earlier phase 'react'/,
			);
		});

		it('still throws on within-phase cycles (delegates to SystemScheduler.topoSort)', () => {
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(
				defineSystem({ name: 'a', phase: 'react', after: 'b', execute: () => {} }),
			);
			scheduler.register(
				defineSystem({ name: 'b', phase: 'react', after: 'a', execute: () => {} }),
			);

			expect(() => scheduler.execute(world)).toThrow(/circular/i);
		});

		it('throws at first execute when a constraint names an unregistered system (matches SystemScheduler)', () => {
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(
				defineSystem({
					name: 'a',
					phase: 'react',
					after: 'nonexistent',
					execute: () => {},
				}),
			);

			expect(() => scheduler.execute(world)).toThrow(
				"System 'a' declares after: 'nonexistent', but no system named 'nonexistent' is registered.",
			);
		});

		it('throws at first execute when before names an unregistered system', () => {
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(
				defineSystem({ name: 'a', phase: 'react', before: 'missing', execute: () => {} }),
			);

			expect(() => scheduler.execute(world)).toThrow(
				"System 'a' declares before: 'missing', but no system named 'missing' is registered.",
			);
		});

		it('register-in-any-order still works across phases — validation is deferred', () => {
			const order: string[] = [];
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(
				defineSystem({ name: 'b', phase: 'react', after: 'a', execute: () => order.push('b') }),
			);
			scheduler.register(
				defineSystem({ name: 'a', phase: 'react', execute: () => order.push('a') }),
			);

			expect(() => scheduler.execute(world)).not.toThrow();
			expect(order).toEqual(['a', 'b']);
		});

		it('removing a constraint target re-validates on the next execute', () => {
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(defineSystem({ name: 'a', phase: 'react', execute: () => {} }));
			scheduler.register(
				defineSystem({ name: 'b', phase: 'react', after: 'a', execute: () => {} }),
			);
			expect(() => scheduler.execute(world)).not.toThrow();

			scheduler.remove('a');
			expect(() => scheduler.execute(world)).toThrow(
				"System 'b' declares after: 'a', but no system named 'a' is registered.",
			);
		});
	});

	describe('phase membership', () => {
		it('throws when a system uses a phase not in the configured list', () => {
			const scheduler = new PhasedScheduler({ phases: ['a', 'b'] as const });
			expect(() =>
				scheduler.register(defineSystem({ name: 's', phase: 'unknown', execute: () => {} })),
			).toThrow(/'s'.*phase 'unknown'.*not in configured phases/);
		});

		it('throws when an unstamped system is registered without a defaultPhase', () => {
			const scheduler = new PhasedScheduler({ phases: ['a', 'b'] as const });
			expect(() => scheduler.register(defineSystem({ name: 's', execute: () => {} }))).toThrow(
				/no `phase`.*no defaultPhase/,
			);
		});

		it('uses defaultPhase when a system is unstamped', () => {
			const order: string[] = [];
			const scheduler = new PhasedScheduler({
				phases: ['a', 'b', 'c'] as const,
				defaultPhase: 'b',
			});
			const world = createWorld();

			scheduler.register(
				defineSystem({ name: 'unstamped', execute: () => order.push('unstamped') }),
			);
			scheduler.register(
				defineSystem({ name: 'stampedC', phase: 'c', execute: () => order.push('c') }),
			);
			scheduler.register(
				defineSystem({ name: 'stampedA', phase: 'a', execute: () => order.push('a') }),
			);

			scheduler.execute(world);
			expect(order).toEqual(['a', 'unstamped', 'c']);
			expect(scheduler.getPhase('unstamped')).toBe('b');
		});
	});

	describe('register / remove', () => {
		it('moves a system to a new phase when re-registered with a different phase', () => {
			const order: string[] = [];
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(
				defineSystem({ name: 'a', phase: 'react', execute: () => order.push('react') }),
			);
			scheduler.register(
				defineSystem({ name: 'a', phase: 'cleanup', execute: () => order.push('cleanup') }),
			);
			scheduler.register(
				defineSystem({ name: 'b', phase: 'derive', execute: () => order.push('derive') }),
			);

			scheduler.execute(world);
			expect(order).toEqual(['derive', 'cleanup']);
			expect(scheduler.getPhase('a')).toBe('cleanup');
		});

		it('invalidates the validation cache after register/remove', () => {
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(defineSystem({ name: 'deriveA', phase: 'derive', execute: () => {} }));
			scheduler.register(
				defineSystem({
					name: 'reactA',
					phase: 'react',
					after: 'deriveA',
					execute: () => {},
				}),
			);

			expect(() => scheduler.execute(world)).toThrow(/later phase/);

			scheduler.remove('reactA');
			expect(() => scheduler.execute(world)).not.toThrow();

			scheduler.register(
				defineSystem({
					name: 'reactA',
					phase: 'react',
					after: 'deriveA',
					execute: () => {},
				}),
			);
			expect(() => scheduler.execute(world)).toThrow(/later phase/);
		});
	});

	describe('introspection', () => {
		it('getPhase returns the registered phase or undefined', () => {
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			scheduler.register(defineSystem({ name: 'a', phase: 'control', execute: () => {} }));

			expect(scheduler.getPhase('a')).toBe('control');
			expect(scheduler.getPhase('nonexistent')).toBeUndefined();
		});

		it('getPhases returns the configured phase order', () => {
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			expect(scheduler.getPhases()).toEqual(TEST_PHASES);
		});

		it('getSystemNames returns names ordered by phase then within-phase topo', () => {
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });

			scheduler.register(
				defineSystem({ name: 'd2', phase: 'derive', after: 'd1', execute: () => {} }),
			);
			scheduler.register(defineSystem({ name: 'd1', phase: 'derive', execute: () => {} }));
			scheduler.register(defineSystem({ name: 'r1', phase: 'react', execute: () => {} }));
			scheduler.register(defineSystem({ name: 'c1', phase: 'cleanup', execute: () => {} }));

			expect(scheduler.getSystemNames()).toEqual(['r1', 'd1', 'd2', 'c1']);
		});
	});

	describe('profiler', () => {
		it('skips empty phases — beginPhase only fires for populated phases', () => {
			const phaseCalls: string[] = [];
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();
			scheduler.profiler = {
				beginSystem: () => {},
				endSystem: () => {},
				beginPhase: (p) => phaseCalls.push(`begin:${p}`),
				endPhase: (p) => phaseCalls.push(`end:${p}`),
			};

			scheduler.register(defineSystem({ name: 'a', phase: 'derive', execute: () => {} }));

			scheduler.execute(world);
			expect(phaseCalls).toEqual(['begin:derive', 'end:derive']);
		});

		it('brackets each phase with beginPhase/endPhase and each system with beginSystem/endSystem', () => {
			const calls: string[] = [];
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();
			scheduler.profiler = {
				beginSystem: (n) => calls.push(`begin:${n}`),
				endSystem: (n) => calls.push(`end:${n}`),
				beginPhase: (p) => calls.push(`beginPhase:${p}`),
				endPhase: (p) => calls.push(`endPhase:${p}`),
			};

			scheduler.register(
				defineSystem({ name: 'r1', phase: 'react', execute: () => calls.push('run:r1') }),
			);
			scheduler.register(
				defineSystem({ name: 'd1', phase: 'derive', execute: () => calls.push('run:d1') }),
			);

			scheduler.execute(world);
			expect(calls).toEqual([
				'beginPhase:react',
				'begin:r1',
				'run:r1',
				'end:r1',
				'endPhase:react',
				'beginPhase:derive',
				'begin:d1',
				'run:d1',
				'end:d1',
				'endPhase:derive',
			]);
		});

		it('works with profilers that omit beginPhase/endPhase', () => {
			const calls: string[] = [];
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();
			const profiler: SystemProfiler = {
				beginSystem: (n) => calls.push(`begin:${n}`),
				endSystem: (n) => calls.push(`end:${n}`),
			};
			scheduler.profiler = profiler;

			scheduler.register(
				defineSystem({ name: 'a', phase: 'react', execute: () => calls.push('run:a') }),
			);

			expect(() => scheduler.execute(world)).not.toThrow();
			expect(calls).toEqual(['begin:a', 'run:a', 'end:a']);
		});
	});

	describe('runIf', () => {
		it('skips systems inside phases when runIf returns false', () => {
			const order: string[] = [];
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();

			scheduler.register(
				defineSystem({
					name: 'skipped',
					phase: 'react',
					runIf: () => false,
					execute: () => order.push('skipped'),
				}),
			);
			scheduler.register(
				defineSystem({ name: 'runs', phase: 'derive', execute: () => order.push('runs') }),
			);

			scheduler.execute(world);
			expect(order).toEqual(['runs']);
		});

		it('still brackets a phase whose only system skipped — skipSystem between', () => {
			const calls: string[] = [];
			const scheduler = new PhasedScheduler({ phases: TEST_PHASES });
			const world = createWorld();
			scheduler.profiler = {
				beginSystem: (n) => calls.push(`begin:${n}`),
				endSystem: (n) => calls.push(`end:${n}`),
				beginPhase: (p) => calls.push(`beginPhase:${p}`),
				endPhase: (p) => calls.push(`endPhase:${p}`),
				skipSystem: (n) => calls.push(`skip:${n}`),
			};

			scheduler.register(
				defineSystem({ name: 'a', phase: 'react', runIf: () => false, execute: () => {} }),
			);

			scheduler.execute(world);
			expect(calls).toEqual(['beginPhase:react', 'skip:a', 'endPhase:react']);
		});
	});

	describe('custom phase vocabularies', () => {
		it('runs a Phaser-style pipeline (ingest, react, control, applyPhysics, cleanup)', () => {
			const order: string[] = [];
			const scheduler = new PhasedScheduler({
				phases: ['ingest', 'react', 'control', 'applyPhysics', 'cleanup'] as const,
			});
			const world = createWorld();

			scheduler.register(
				defineSystem({
					name: 'physWrite',
					phase: 'applyPhysics',
					execute: () => order.push('apply'),
				}),
			);
			scheduler.register(
				defineSystem({ name: 'physRead', phase: 'ingest', execute: () => order.push('ingest') }),
			);
			scheduler.register(
				defineSystem({ name: 'collide', phase: 'react', execute: () => order.push('react') }),
			);

			scheduler.execute(world);
			expect(order).toEqual(['ingest', 'react', 'apply']);
		});

		it('runs a 2-phase pipeline (update, render)', () => {
			const order: string[] = [];
			const scheduler = new PhasedScheduler({
				phases: ['update', 'render'] as const,
			});
			const world = createWorld();

			scheduler.register(
				defineSystem({ name: 'r', phase: 'render', execute: () => order.push('render') }),
			);
			scheduler.register(
				defineSystem({ name: 'u', phase: 'update', execute: () => order.push('update') }),
			);

			scheduler.execute(world);
			expect(order).toEqual(['update', 'render']);
		});
	});
});
