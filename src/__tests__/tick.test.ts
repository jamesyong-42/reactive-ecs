import { describe, expect, it } from 'vitest';
import { defineComponent } from '../define.js';
import { tickWorld } from '../tick.js';
import { createWorld } from '../world.js';

const Position = defineComponent('Position', { x: 0, y: 0 });

describe('tickWorld', () => {
	it('runs fn, then emitFrame, then clearDirty, then incrementTick', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Position, { x: 1 });
		world.clearDirty();

		const order: string[] = [];
		world.onFrame(() => {
			// emitFrame runs AFTER fn (its write is visible in the buffers)
			// and BEFORE clearDirty/incrementTick.
			order.push('frame');
			expect(world.queryChanged(Position)).toEqual([e]);
			expect(world.currentTick).toBe(0);
		});

		tickWorld(world, (w) => {
			order.push('fn');
			w.patchComponent(e, Position, { x: 2 });
		});

		expect(order).toEqual(['fn', 'frame']);
		// After the tick: buffers cleared, tick incremented.
		expect(world.queryChanged(Position)).toEqual([]);
		expect(world.currentTick).toBe(1);
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
		expect(world.queryAdded(Position)).toEqual([]);
		expect(world.currentTick).toBe(1);

		tickWorld(world);
		expect(frames).toBe(2);
		expect(world.currentTick).toBe(2);
	});
});
