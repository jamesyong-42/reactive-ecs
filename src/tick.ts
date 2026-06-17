import type { World } from './types.js';
import type { WorldInternal } from './world.js';

/**
 * Runs one frame: `fn(world)` if provided, then the world's single frame-advance
 * step — seal the open origin-run, reset the tick window, deliver sealed runs to
 * `onChanges`, fire `onFrame`, and increment the tick (RFC-006). Delivery happens
 * AFTER the reset, so a handler's own mutations land in the next tick; the frame
 * always advances even if a handler throws, and an `AggregateError` (or the lone
 * error) is rethrown after the clock has moved.
 *
 * Call with no `fn` to flush + advance a frame without running systems:
 *   tickWorld(world);
 */
export function tickWorld(world: World, fn?: (world: World) => void): void {
	(world as WorldInternal).advanceFrame(fn);
}
