import type { ComponentType, Origin, RelationType, TagType, World, WorldChanges } from './types.js';

/**
 * A change-set entry `applyChanges` did not replay: a reference to a dead entity,
 * or an entity-lifecycle entry (`created`/`destroyed`) — which `applyChanges`
 * never replays, because entity creation/destruction is app policy (tombstone
 * doctrine, or an identity index for resurrection). See RFC-006 §identity.
 */
export interface SkippedEntry {
	readonly reason: 'dead-entity' | 'lifecycle';
	readonly entity: number;
	readonly detail: string;
}

export interface ApplyChangesOptions {
	/** Apply the INVERSE (undo): added↔removed, prev↔next. Default false. */
	readonly invert?: boolean;
	/**
	 * Tag every replayed mutation with this origin (e.g. a `HISTORY` symbol so an
	 * `onChanges` recorder filtering `origin === undefined` ignores the replay).
	 */
	readonly origin?: Origin;
	/**
	 * Dead-entity references: `'throw'` (default) validates up front and throws
	 * before mutating anything; `'skip'` no-ops them and reports them in `skipped`.
	 */
	readonly onMissing?: 'throw' | 'skip';
}

export interface ApplyChangesResult {
	/** Entries that were not replayed (dead entities + lifecycle). */
	readonly skipped: readonly SkippedEntry[];
}

/**
 * Replay a `WorldChanges` (or its inverse) through the public write API — the
 * ground support that makes app-level undo/redo ~15 lines (RFC-006). Built
 * entirely on `World`; carries no privileged access.
 *
 *   redo: applyChanges(world, c, { origin: HISTORY })
 *   undo: applyChanges(world, c, { origin: HISTORY, invert: true })
 *
 * Validate-first: with `onMissing: 'throw'` (default) it scans for dead-entity
 * references and throws before any mutation, so a partial apply can't corrupt the
 * world. Component/tag/relation/resource changes are replayed; entity lifecycle
 * (`created`/`destroyed`) is NOT — that is app policy (tombstone or identity
 * index) — and is reported in `skipped`. Removes/unrelates run before adds/relates
 * so exclusivity replacement applies cleanly.
 */
export function applyChanges(
	world: World,
	changes: WorldChanges,
	opts?: ApplyChangesOptions,
): ApplyChangesResult {
	const invert = opts?.invert ?? false;
	const onMissing = opts?.onMissing ?? 'throw';
	const skipped: SkippedEntry[] = [];

	const componentTypes = world.getRegisteredComponents();
	const tagTypes = world.getRegisteredTags();
	const relationTypes = world.getRegisteredRelations();

	// --- validate-first: gather every dead-entity reference + lifecycle entries ---
	const deadEntities = new Set<number>();
	const note = (e: number, detail: string) => {
		if (!world.entityExists(e)) {
			deadEntities.add(e);
			skipped.push({ reason: 'dead-entity', entity: e, detail });
		}
	};
	for (const C of componentTypes) {
		for (const e of changes.added(C).keys()) note(e, `${C.name} on dead entity ${e}`);
		for (const e of changes.changed(C).keys()) note(e, `${C.name} on dead entity ${e}`);
		for (const e of changes.removed(C).keys()) note(e, `${C.name} on dead entity ${e}`);
	}
	for (const T of tagTypes) {
		for (const e of changes.addedTag(T)) note(e, `tag ${T.name} on dead entity ${e}`);
		for (const e of changes.removedTag(T)) note(e, `tag ${T.name} on dead entity ${e}`);
	}
	for (const R of relationTypes) {
		for (const [s, t] of changes.addedRelation(R)) {
			note(s, `relation ${R.name} source ${s}`);
			note(t, `relation ${R.name} target ${t}`);
		}
		for (const [s, t] of changes.removedRelation(R)) {
			note(s, `relation ${R.name} source ${s}`);
			note(t, `relation ${R.name} target ${t}`);
		}
	}
	for (const e of changes.created) {
		skipped.push({
			reason: 'lifecycle',
			entity: e,
			detail: `created ${e} — entity lifecycle is app policy`,
		});
	}
	for (const e of changes.destroyed) {
		skipped.push({
			reason: 'lifecycle',
			entity: e,
			detail: `destroyed ${e} — entity lifecycle is app policy`,
		});
	}

	if (onMissing === 'throw' && deadEntities.size > 0) {
		const first = skipped.find((s) => s.reason === 'dead-entity');
		throw new Error(
			`applyChanges: ${deadEntities.size} change(s) reference dead entities — ` +
				`pass { onMissing: 'skip' } to ignore them. First: ${first?.detail}`,
		);
	}

	const live = (e: number) => !deadEntities.has(e);

	const apply = () => {
		for (const C of componentTypes) applyComponent(world, changes, C, invert, live);
		for (const T of tagTypes) applyTag(world, changes, T, invert, live);
		for (const R of relationTypes) applyRelation(world, changes, R, invert, live);
		applyResources(world, changes, invert);
	};

	if (opts?.origin !== undefined) {
		world.withOrigin(opts.origin, apply);
	} else {
		apply();
	}
	return { skipped };
}

function applyComponent<T>(
	world: World,
	changes: WorldChanges,
	type: ComponentType<T>,
	invert: boolean,
	live: (e: number) => boolean,
): void {
	const added = changes.added(type);
	const changed = changes.changed(type);
	const removed = changes.removed(type);
	if (!invert) {
		for (const e of removed.keys()) if (live(e)) world.removeComponent(e, type);
		for (const [e, v] of added) if (live(e)) world.addComponent(e, type, v as Partial<T>);
		for (const [e, ch] of changed) if (live(e)) world.addComponent(e, type, ch.next as Partial<T>);
	} else {
		for (const e of added.keys()) if (live(e)) world.removeComponent(e, type);
		for (const [e, v] of removed) if (live(e)) world.addComponent(e, type, v as Partial<T>);
		for (const [e, ch] of changed) if (live(e)) world.addComponent(e, type, ch.prev as Partial<T>);
	}
}

function applyTag(
	world: World,
	changes: WorldChanges,
	type: TagType,
	invert: boolean,
	live: (e: number) => boolean,
): void {
	const added = changes.addedTag(type);
	const removed = changes.removedTag(type);
	const toRemove = invert ? added : removed;
	const toAdd = invert ? removed : added;
	for (const e of toRemove) if (live(e)) world.removeTag(e, type);
	for (const e of toAdd) if (live(e)) world.addTag(e, type);
}

function applyRelation(
	world: World,
	changes: WorldChanges,
	type: RelationType,
	invert: boolean,
	live: (e: number) => boolean,
): void {
	const added = changes.addedRelation(type);
	const removed = changes.removedRelation(type);
	const toUnrelate = invert ? added : removed;
	const toRelate = invert ? removed : added;
	for (const [s, t] of toUnrelate) if (live(s) && live(t)) world.unrelate(s, type, t);
	for (const [s, t] of toRelate) if (live(s) && live(t)) world.relate(s, type, t);
}

function applyResources(world: World, changes: WorldChanges, invert: boolean): void {
	for (const [type, ch] of changes.changedResources()) {
		world.setResource(type, (invert ? ch.prev : ch.next) as Partial<unknown>);
	}
}
