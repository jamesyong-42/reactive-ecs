import type { World } from './types.js';

/**
 * Runs one frame using the recommended protocol: `fn(world)` if provided,
 * then `world.emitFrame()`, `world.clearDirty()`, `world.incrementTick()` —
 * in that order, so onFrame subscribers still see this tick's buffers and
 * tick number. Equivalent to the four manual calls:
 *
 *   tickWorld(world, (w) => scheduler.execute(w));
 *   // ≡ scheduler.execute(world); world.emitFrame();
 *   //   world.clearDirty(); world.incrementTick();
 */
export function tickWorld(world: World, fn?: (world: World) => void): void {
	if (fn) fn(world);
	world.emitFrame();
	world.clearDirty();
	world.incrementTick();
}
