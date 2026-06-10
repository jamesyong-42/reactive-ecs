// Entity-lifecycle recorder — the headless data layer behind the devtools Timeline.
//
// A flat entity list can't show CHURN: short-lived entities (e.g. gesture recognizers that
// spawn three-at-once and die within 1–2 ticks via arbitration) are born and killed between
// UI polls. A 16 Hz React poll simply misses entities that live for one tick.
//
// So we capture lifecycle from the EVENT hooks, not a poll: world.onEntityCreated /
// onEntityDestroyed fire synchronously inside the tick, so every entity is recorded — even the
// 1-tick ones. The ECS fires destroy listeners BEFORE tearing down components (see
// createWorld's destroyEntity), so inside onEntityDestroyed the entity is still fully
// readable — that's where we freeze a dying entity's final descriptor.

import type { EntityId, World } from '../types.js';
import { defaultDescriber, type EntityDescriber, type EntityDescriptor } from './describer.js';

/** One segment per entity, born→died in both tick & ms. */
export interface LifeRecord {
	id: EntityId;
	bornTick: number;
	/** Session-relative ms (recorder `now()`), monotonic from recorder creation. */
	bornMs: number;
	/** null while the entity is alive. */
	diedTick: number | null;
	diedMs: number | null;
	/**
	 * Descriptor FROZEN at death (the entity is still readable inside onEntityDestroyed).
	 * null while alive — read live via the describer instead (see the timeline).
	 */
	descriptor: EntityDescriptor | null;
}

export interface LifecycleRecorder {
	/** Every record in birth order — this IS the timeline's row order. */
	records(): readonly LifeRecord[];
	/** Session-relative ms — the live-tail right edge in ms mode. */
	nowMs(): number;
	/** Drop all DEAD records; living entities keep their true birth. (Timeline "Clear".) */
	clear(): void;
	/** Unsubscribe from the world. */
	dispose(): void;
}

export interface LifecycleRecorderOptions {
	/** Max records kept; the oldest DEAD records are evicted first — never a living entity. */
	cap?: number;
	/** Freezes a dying entity's identity; defaults to {@link defaultDescriber}. */
	describer?: EntityDescriber;
	/** Clock for the ms axis; defaults to `performance.now()` rebased to 0 at creation. */
	now?: () => number;
}

/**
 * Attach lifecycle capture to a world. Create it BEFORE the world's entities are spawned so
 * persistent entities are caught at birth too. `cap` bounds memory by evicting the oldest
 * DEAD records first — never a living entity.
 */
export function createLifecycleRecorder(
	world: World,
	opts: LifecycleRecorderOptions = {},
): LifecycleRecorder {
	const cap = opts.cap ?? 4000;
	const describer = opts.describer ?? defaultDescriber;
	let now = opts.now;
	if (!now) {
		const origin = performance.now();
		now = () => performance.now() - origin;
	}
	const list: LifeRecord[] = [];
	const byId = new Map<EntityId, LifeRecord>();

	const evict = (): void => {
		const target = list.length - cap;
		let removed = 0;
		for (let i = 0; i < list.length && removed < target; ) {
			if (list[i].diedMs !== null) {
				byId.delete(list[i].id);
				list.splice(i, 1);
				removed++;
			} else {
				i++;
			}
		}
	};

	const offBorn = world.onEntityCreated((id: EntityId) => {
		// components aren't attached yet at createEntity — identity is resolved live while
		// alive (via the describer), frozen at death
		const rec: LifeRecord = {
			id,
			bornTick: world.currentTick,
			bornMs: now(),
			diedTick: null,
			diedMs: null,
			descriptor: null,
		};
		list.push(rec);
		byId.set(id, rec);
		if (list.length > cap) evict();
	});

	const offDied = world.onEntityDestroyed((id: EntityId) => {
		const rec = byId.get(id);
		if (!rec) return;
		rec.diedTick = world.currentTick;
		rec.diedMs = now();
		// still fully readable here — freeze the final identity (e.g. a terminal phase)
		rec.descriptor = describer(world, id);
	});

	return {
		records: () => list,
		nowMs: now,
		clear() {
			for (let i = list.length - 1; i >= 0; i--) {
				if (list[i].diedMs !== null) {
					byId.delete(list[i].id);
					list.splice(i, 1);
				}
			}
		},
		dispose() {
			offBorn();
			offDied();
		},
	};
}
