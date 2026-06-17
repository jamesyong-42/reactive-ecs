import { describe, expect, it } from 'vitest';
import { defineComponent } from '../define.js';
import { tickWorld } from '../tick.js';
import { createWorld } from '../world.js';

const Position = defineComponent('Position', { x: 0, y: 0 });

describe('tickWorld', () => {
	it('runs fn, then seal+reset+deliver, then onFrame, then incrementTick (RFC-006 order)', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Position, { x: 1 });
		tickWorld(world);

		const order: string[] = [];
		// onChanges delivery happens before onFrame; the window is already reset.
		world.onChanges(() => order.push('deliver'));
		world.onFrame(() => {
			// onFrame is now the POST-delivery flush hook: the tick window has been
			// reset (buffers cleared) and the tick has not yet incremented.
			order.push('frame');
			expect([...world.changes().changed(Position).keys()]).toEqual([]);
			expect(world.currentTick).toBe(1);
		});

		tickWorld(world, (w) => {
			order.push('fn');
			w.patchComponent(e, Position, { x: 2 });
		});

		expect(order).toEqual(['fn', 'deliver', 'frame']);
		// After the tick: buffers cleared, tick incremented.
		expect([...world.changes().changed(Position).keys()]).toEqual([]);
		expect(world.currentTick).toBe(2);
	});

	it('passes the world to fn', () => {
		const world = createWorld();
		let received: unknown;
		tickWorld(world, (w) => {
			received = w;
		});
		expect(received).toBe(world);
	});

	it('works with no fn — still emits the frame and advances the tick', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Position, { x: 1 });

		let frames = 0;
		world.onFrame(() => frames++);

		tickWorld(world);
		expect(frames).toBe(1);
		expect([...world.changes().added(Position).keys()]).toEqual([]);
		expect(world.currentTick).toBe(1);

		tickWorld(world);
		expect(frames).toBe(2);
		expect(world.currentTick).toBe(2);
	});
});
