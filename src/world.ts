import type {
	ComponentChangedHandler,
	ComponentRemovedHandler,
	ComponentType,
	EntityId,
	FrameHandler,
	NotTerm,
	QueryResult,
	RelationEdge,
	RelationHandler,
	RelationType,
	ResourceType,
	TagChangedHandler,
	TagType,
	Unsubscribe,
	World,
} from './types.js';

/** Internal storage for a single component type */
interface ComponentStore<T = unknown> {
	/** Identity anchor — used to detect name collisions across defineComponent() calls. */
	type: ComponentType<T>;
	data: Map<EntityId, T>;
	dirty: Set<EntityId>;
	added: Set<EntityId>;
	removed: Set<EntityId>;
	handlers: Map<EntityId | '*', Set<ComponentChangedHandler<T>>>;
	removedHandlers: Map<EntityId | '*', Set<ComponentRemovedHandler<T>>>;
}

/** Internal storage for a single tag type */
interface TagStore {
	/** Identity anchor — used to detect name collisions across defineTag() calls. */
	type: TagType;
	entities: Set<EntityId>;
	added: Set<EntityId>;
	removed: Set<EntityId>;
	addedHandlers: Map<EntityId | '*', Set<TagChangedHandler>>;
	removedHandlers: Map<EntityId | '*', Set<TagChangedHandler>>;
}

/** Internal storage for a single relation type */
interface RelationStore {
	/** Identity anchor — used to detect name collisions across defineRelation() calls. */
	type: RelationType;
	/** source → targets (sourceExclusive ⇒ size ≤ 1) */
	forward: Map<EntityId, Set<EntityId>>;
	/** target → sources (targetExclusive ⇒ size ≤ 1) */
	inverse: Map<EntityId, Set<EntityId>>;
	/** Edge keys added this tick */
	added: Set<string>;
	/** Edge keys removed this tick (including destroy-driven removals) */
	removed: Set<string>;
	addedHandlers: Map<EntityId | '*', Set<RelationHandler>>;
	removedHandlers: Map<EntityId | '*', Set<RelationHandler>>;
}

/** Buffer key for a single relation edge — `\0` cannot appear in a numeric id. */
function edgeKey(source: EntityId, target: EntityId): string {
	return `${source}\0${target}`;
}

/** Decode buffered edge keys back into numeric `[source, target]` pairs. */
function decodeEdgeKeys(keys: Set<string>): [EntityId, EntityId][] {
	const result: [EntityId, EntityId][] = [];
	for (const key of keys) {
		const sep = key.indexOf('\0');
		result.push([Number(key.slice(0, sep)), Number(key.slice(sep + 1))]);
	}
	return result;
}

/**
 * Instantiate a value from `defaults`, applying optional `overrides`, and
 * deep-clone nested arrays / plain objects so callers can't accidentally share
 * state with the type's defaults or with each other.
 */
function instantiateDefaults<T>(defaults: T, overrides?: Partial<T>): T {
	const merged = (overrides ? { ...defaults, ...overrides } : { ...defaults }) as T;
	for (const key in merged) {
		const val = merged[key];
		if (Array.isArray(val)) {
			(merged as Record<string, unknown>)[key] = [...val];
		} else if (val !== null && typeof val === 'object' && (val as object).constructor === Object) {
			(merged as Record<string, unknown>)[key] = { ...val };
		}
	}
	return merged;
}

export function createWorld(): World {
	let nextEntityId = 1;
	let currentTick = 0;
	const alive = new Set<EntityId>();

	// Component storage: one Map per component type
	const components = new Map<string, ComponentStore>();
	// Tag storage: one Set per tag type
	const tags = new Map<string, TagStore>();
	// Relation storage: one edge index per relation type — a side index,
	// never an archetype/query key, so the query cache is untouched.
	const relations = new Map<string, RelationStore>();
	// Resources: one value per resource type
	const resources = new Map<string, unknown>();
	// Identity anchors for resources — same purpose as ComponentStore.type
	const resourceTypes = new Map<string, ResourceType>();
	// Frame handlers
	const frameHandlers = new Set<FrameHandler>();
	// Create listeners — called after the entity id is assigned and marked alive
	const createListeners = new Set<(entity: EntityId) => void>();
	// Destroy listeners — called before components/tags are removed
	const destroyListeners = new Set<(entity: EntityId) => void>();

	// === Query cache ===
	// Key: sorted type names joined by '\0' — negated names are prefixed with '!'
	// so query(A, Not(B)) and query(A, B) can never collide
	// Value: live Set<EntityId> of entities matching all types in the key
	const queryCache = new Map<string, Set<EntityId>>();
	// Reverse index: typeName → Set<queryKey> — which cached queries use this type.
	// Negated type names are registered too: adding/removing the negated type
	// must re-evaluate membership in queries that exclude it.
	const typeToQueries = new Map<string, Set<string>>();
	// Store the type names per query key for re-evaluation
	const queryKeyTypes = new Map<
		string,
		{ components: string[]; tags: string[]; notComponents: string[]; notTags: string[] }
	>();

	function getQueryKey(types: (ComponentType | TagType | NotTerm)[]): string {
		return types
			.map((t) => (t.__kind === 'not' ? `!${t.type.name}` : t.name))
			.sort()
			.join('\0');
	}

	function buildQueryResult(
		compNames: string[],
		tagNames: string[],
		notCompNames: string[],
		notTagNames: string[],
	): Set<EntityId> {
		const result = new Set<EntityId>();

		// Find smallest set to start iteration
		let smallest: Set<EntityId> | null = null;
		let smallestSize = Number.POSITIVE_INFINITY;

		for (const name of compNames) {
			const store = components.get(name);
			if (!store || store.data.size === 0) return result; // empty — no matches
			if (store.data.size < smallestSize) {
				smallestSize = store.data.size;
				smallest = new Set(store.data.keys());
			}
		}
		for (const name of tagNames) {
			const store = tags.get(name);
			if (!store || store.entities.size === 0) return result;
			if (store.entities.size < smallestSize) {
				smallestSize = store.entities.size;
				smallest = store.entities;
			}
		}

		if (!smallest) return result;

		for (const entity of smallest) {
			if (!alive.has(entity)) continue;
			if (matchesQuery(entity, compNames, tagNames, notCompNames, notTagNames)) {
				result.add(entity);
			}
		}
		return result;
	}

	function matchesQuery(
		entity: EntityId,
		compNames: string[],
		tagNames: string[],
		notCompNames: string[],
		notTagNames: string[],
	): boolean {
		for (const name of compNames) {
			if (!components.get(name)?.data.has(entity)) return false;
		}
		for (const name of tagNames) {
			if (!tags.get(name)?.entities.has(entity)) return false;
		}
		// Negated terms — a missing store counts as absent (optional chaining)
		for (const name of notCompNames) {
			if (components.get(name)?.data.has(entity)) return false;
		}
		for (const name of notTagNames) {
			if (tags.get(name)?.entities.has(entity)) return false;
		}
		return true;
	}

	/** Update all cached queries that include this type name */
	function updateCachesForEntity(typeName: string, entity: EntityId) {
		const queryKeys = typeToQueries.get(typeName);
		if (!queryKeys) return;
		for (const key of queryKeys) {
			const cached = queryCache.get(key);
			const types = queryKeyTypes.get(key);
			if (!cached || !types) continue;
			if (matchesQuery(entity, types.components, types.tags, types.notComponents, types.notTags)) {
				cached.add(entity);
			} else {
				cached.delete(entity);
			}
		}
	}

	/** Remove entity from all cached queries */
	function removeCachesForEntity(entity: EntityId) {
		for (const cached of queryCache.values()) {
			cached.delete(entity);
		}
	}

	function getComponentStore<T>(type: ComponentType<T>): ComponentStore<T> {
		const existing = components.get(type.name) as ComponentStore<T> | undefined;
		if (existing) {
			if (existing.type !== type) {
				throw new Error(
					`Component name collision: "${type.name}" is already registered to a different ComponentType. ` +
						`Names must be unique across all defineComponent() calls.`,
				);
			}
			return existing;
		}
		const store: ComponentStore<T> = {
			type,
			data: new Map(),
			dirty: new Set(),
			added: new Set(),
			removed: new Set(),
			handlers: new Map(),
			removedHandlers: new Map(),
		};
		// Cast to the erased type held in the Map. Safe — see note on getComponentStore's return.
		components.set(type.name, store as ComponentStore);
		return store;
	}

	function getTagStore(type: TagType): TagStore {
		const existing = tags.get(type.name);
		if (existing) {
			if (existing.type !== type) {
				throw new Error(
					`Tag name collision: "${type.name}" is already registered to a different TagType. ` +
						`Names must be unique across all defineTag() calls.`,
				);
			}
			return existing;
		}
		const store: TagStore = {
			type,
			entities: new Set(),
			added: new Set(),
			removed: new Set(),
			addedHandlers: new Map(),
			removedHandlers: new Map(),
		};
		tags.set(type.name, store);
		return store;
	}

	function getRelationStore(type: RelationType): RelationStore {
		const existing = relations.get(type.name);
		if (existing) {
			if (existing.type !== type) {
				throw new Error(
					`Relation name collision: "${type.name}" is already registered to a different RelationType. ` +
						`Names must be unique across all defineRelation() calls.`,
				);
			}
			return existing;
		}
		const store: RelationStore = {
			type,
			forward: new Map(),
			inverse: new Map(),
			added: new Set(),
			removed: new Set(),
			addedHandlers: new Map(),
			removedHandlers: new Map(),
		};
		relations.set(type.name, store);
		return store;
	}

	function hasListeners<T>(store: ComponentStore<T>): boolean {
		if (store.handlers.size === 0) return false;
		for (const set of store.handlers.values()) {
			if (set.size > 0) return true;
		}
		return false;
	}

	function emitComponentChanged<T>(
		store: ComponentStore<T>,
		entityId: EntityId,
		prev: T | undefined,
		next: T,
	) {
		const entityHandlers = store.handlers.get(entityId);
		if (entityHandlers) {
			for (const h of entityHandlers) h(entityId, prev, next);
		}
		const wildcardHandlers = store.handlers.get('*');
		if (wildcardHandlers) {
			for (const h of wildcardHandlers) h(entityId, prev, next);
		}
	}

	function emitComponentRemoved<T>(store: ComponentStore<T>, entityId: EntityId, prev: T) {
		const entityHandlers = store.removedHandlers.get(entityId);
		if (entityHandlers) {
			for (const h of entityHandlers) h(entityId, prev);
		}
		const wildcardHandlers = store.removedHandlers.get('*');
		if (wildcardHandlers) {
			for (const h of wildcardHandlers) h(entityId, prev);
		}
	}

	function emitTagAdded(store: TagStore, entityId: EntityId) {
		const entityHandlers = store.addedHandlers.get(entityId);
		if (entityHandlers) {
			for (const h of entityHandlers) h(entityId);
		}
		const wildcardHandlers = store.addedHandlers.get('*');
		if (wildcardHandlers) {
			for (const h of wildcardHandlers) h(entityId);
		}
	}

	function emitTagRemoved(store: TagStore, entityId: EntityId) {
		const entityHandlers = store.removedHandlers.get(entityId);
		if (entityHandlers) {
			for (const h of entityHandlers) h(entityId);
		}
		const wildcardHandlers = store.removedHandlers.get('*');
		if (wildcardHandlers) {
			for (const h of wildcardHandlers) h(entityId);
		}
	}

	function emitRelationAdded(store: RelationStore, source: EntityId, target: EntityId) {
		const sourceHandlers = store.addedHandlers.get(source);
		if (sourceHandlers) {
			for (const h of sourceHandlers) h(source, target);
		}
		const wildcardHandlers = store.addedHandlers.get('*');
		if (wildcardHandlers) {
			for (const h of wildcardHandlers) h(source, target);
		}
	}

	function emitRelationRemoved(store: RelationStore, source: EntityId, target: EntityId) {
		const sourceHandlers = store.removedHandlers.get(source);
		if (sourceHandlers) {
			for (const h of sourceHandlers) h(source, target);
		}
		const wildcardHandlers = store.removedHandlers.get('*');
		if (wildcardHandlers) {
			for (const h of wildcardHandlers) h(source, target);
		}
	}

	/**
	 * Remove a single edge from both indexes, populate the `removed` buffer
	 * (net-cancelling a same-tick add), and emit onRelationRemoved. Shared by
	 * unrelate, exclusivity replacement, and the destroy sweep.
	 */
	function removeRelationEdge(store: RelationStore, source: EntityId, target: EntityId) {
		const targets = store.forward.get(source);
		if (targets) {
			targets.delete(target);
			if (targets.size === 0) store.forward.delete(source);
		}
		const sources = store.inverse.get(target);
		if (sources) {
			sources.delete(source);
			if (sources.size === 0) store.inverse.delete(target);
		}
		const key = edgeKey(source, target);
		store.removed.add(key);
		// Net-cancellation with queryRelationAdded in the same tick.
		store.added.delete(key);
		emitRelationRemoved(store, source, target);
	}

	const world: World = {
		get currentTick() {
			return currentTick;
		},

		get entityCount() {
			return alive.size;
		},

		// === Entity lifecycle ===

		createEntity(): EntityId {
			const id = nextEntityId++;
			alive.add(id);
			for (const listener of createListeners) listener(id);
			return id;
		},

		createEntityWithId(id: EntityId): EntityId {
			if (!Number.isInteger(id) || id < 1) {
				throw new Error(`createEntityWithId(${id}): id must be a positive integer`);
			}
			if (alive.has(id)) {
				throw new Error(`createEntityWithId(${id}): id is already alive`);
			}
			if (id < nextEntityId) {
				throw new Error(
					`createEntityWithId(${id}): id is below the counter (${nextEntityId}); ` +
						`ids are never reused — restore entities in ascending order`,
				);
			}
			nextEntityId = id + 1;
			alive.add(id);
			for (const listener of createListeners) listener(id);
			return id;
		},

		setNextEntityId(n: number): void {
			if (!Number.isInteger(n) || n < nextEntityId) {
				throw new Error(
					`setNextEntityId(${n}): counter only moves forward (currently ${nextEntityId})`,
				);
			}
			nextEntityId = n;
		},

		destroyEntity(id: EntityId) {
			if (!alive.has(id)) return;
			// Notify destroy listeners BEFORE removing components/tags
			// so callbacks can still read the entity's data
			for (const listener of destroyListeners) listener(id);
			alive.delete(id);
			// Remove from all cached queries
			removeCachesForEntity(id);
			// Relation sweep — BEFORE component/tag teardown so onRelationRemoved
			// handlers can still read the dying entity's data. Policy effects are
			// collected here and applied only after teardown completes: mutating
			// mid-sweep would observe a half-destroyed world.
			const deferredEffects: (
				| { kind: 'destroy'; source: EntityId }
				| { kind: 'tag'; source: EntityId; tag: TagType }
			)[] = [];
			for (const store of relations.values()) {
				// id as source — outgoing edges simply vanish, symmetric to
				// component teardown. No policy applies; the source is gone.
				const targets = store.forward.get(id);
				if (targets) {
					for (const target of [...targets]) removeRelationEdge(store, id, target);
				}
				// id as target — each incoming edge is removed AND the relation's
				// onTargetDestroy policy contributes a deferred effect per source.
				const sources = store.inverse.get(id);
				if (sources) {
					const policy = store.type.options.onTargetDestroy;
					for (const source of [...sources]) {
						removeRelationEdge(store, source, id);
						if (policy === 'cascade') {
							deferredEffects.push({ kind: 'destroy', source });
						} else if (policy !== 'clear') {
							deferredEffects.push({ kind: 'tag', source, tag: policy.tag });
						}
					}
				}
				store.addedHandlers.delete(id);
				store.removedHandlers.delete(id);
			}
			// Remove all components — fire onComponentRemoved per owned component
			// and populate the per-tick `removed` buffer so queryRemoved sees the id.
			for (const store of components.values()) {
				if (store.data.has(id)) {
					const prev = store.data.get(id);
					emitComponentRemoved(store, id, prev);
					store.removed.add(id);
				}
				store.data.delete(id);
				store.dirty.delete(id);
				store.added.delete(id);
				store.handlers.delete(id);
				store.removedHandlers.delete(id);
			}
			// Remove all tags — fire onTagRemoved per owned tag and populate
			// the per-tick `removed` buffer.
			for (const store of tags.values()) {
				if (store.entities.has(id)) {
					emitTagRemoved(store, id);
					store.removed.add(id);
				}
				store.entities.delete(id);
				store.added.delete(id);
				store.addedHandlers.delete(id);
				store.removedHandlers.delete(id);
			}
			// Apply deferred relation policy effects — only now is mutation safe.
			for (const effect of deferredEffects) {
				if (effect.kind === 'destroy') {
					// An already-dead source is a no-op via the alive guard above.
					// Cascade chains and cycles terminate: ids are never reused and
					// re-destroying is a no-op.
					world.destroyEntity(effect.source);
				} else if (alive.has(effect.source)) {
					// Skipped if a prior effect destroyed the source.
					world.addTag(effect.source, effect.tag);
				}
			}
		},

		entityExists(id: EntityId): boolean {
			return alive.has(id);
		},

		// === Component access ===

		addComponent<T>(entity: EntityId, type: ComponentType<T>, data: T) {
			if (!alive.has(entity)) {
				throw new Error(
					`addComponent(${type.name}): entity ${entity} does not exist or has been destroyed`,
				);
			}
			const store = getComponentStore(type);
			const merged = instantiateDefaults(type.defaults, data as Partial<T>);
			store.data.set(entity, merged);
			store.dirty.add(entity);
			store.added.add(entity);
			// Net-cancellation with queryRemoved: re-adding within the same tick
			// undoes a prior remove from the buffer.
			store.removed.delete(entity);
			// Update cached queries that include this component
			updateCachesForEntity(type.name, entity);
			emitComponentChanged(store, entity, undefined, merged);
		},

		removeComponent<T>(entity: EntityId, type: ComponentType<T>) {
			const store = getComponentStore(type);
			if (store.data.has(entity)) {
				const prev = store.data.get(entity) as T;
				// Fire onComponentRemoved BEFORE data is deleted so `prev` is
				// readable from the store too if the handler wants it.
				emitComponentRemoved(store, entity, prev);
				store.removed.add(entity);
			}
			store.data.delete(entity);
			store.dirty.delete(entity);
			store.added.delete(entity);
			// Update cached queries — entity may no longer match
			updateCachesForEntity(type.name, entity);
		},

		getComponent<T>(entity: EntityId, type: ComponentType<T>): T | undefined {
			const store = getComponentStore(type);
			return store.data.get(entity);
		},

		hasComponent(entity: EntityId, type: ComponentType): boolean {
			const store = getComponentStore(type);
			return store.data.has(entity);
		},

		// Only allocate prev object when there are listeners
		setComponent<T>(entity: EntityId, type: ComponentType<T>, data: Partial<T>) {
			const store = getComponentStore(type);
			const existing = store.data.get(entity);
			if (!existing) return;
			if (hasListeners(store)) {
				const prev = { ...existing };
				Object.assign(existing, data);
				store.dirty.add(entity);
				emitComponentChanged(store, entity, prev, existing);
			} else {
				Object.assign(existing, data);
				store.dirty.add(entity);
			}
		},

		// === Tag access ===

		addTag(entity: EntityId, type: TagType) {
			if (!alive.has(entity)) {
				throw new Error(
					`addTag(${type.name}): entity ${entity} does not exist or has been destroyed`,
				);
			}
			const store = getTagStore(type);
			if (store.entities.has(entity)) return;
			store.entities.add(entity);
			store.added.add(entity);
			// Net-cancellation with queryRemovedTag in the same tick.
			store.removed.delete(entity);
			// Update cached queries that include this tag
			updateCachesForEntity(type.name, entity);
			emitTagAdded(store, entity);
		},

		removeTag(entity: EntityId, type: TagType) {
			const store = getTagStore(type);
			if (!store.entities.has(entity)) return;
			store.entities.delete(entity);
			store.removed.add(entity);
			// Net-cancellation with queryAddedTag in the same tick.
			store.added.delete(entity);
			// Update cached queries — entity may no longer match
			updateCachesForEntity(type.name, entity);
			emitTagRemoved(store, entity);
		},

		hasTag(entity: EntityId, type: TagType): boolean {
			const store = getTagStore(type);
			return store.entities.has(entity);
		},

		// === Relation access ===

		relate(source: EntityId, type: RelationType, target: EntityId) {
			if (!alive.has(source)) {
				throw new Error(
					`relate(${type.name}): source entity ${source} does not exist or has been destroyed`,
				);
			}
			if (!alive.has(target)) {
				throw new Error(
					`relate(${type.name}): target entity ${target} does not exist or has been destroyed`,
				);
			}
			const store = getRelationStore(type);
			if (store.forward.get(source)?.has(target)) return;
			// Exclusivity violation replaces — the displaced edge is removed with
			// full removed-event semantics BEFORE the add, mirroring setComponent
			// overwrite (removed-then-added).
			if (type.options.sourceExclusive) {
				const existingTargets = store.forward.get(source);
				if (existingTargets) {
					for (const t of [...existingTargets]) removeRelationEdge(store, source, t);
				}
			}
			if (type.options.targetExclusive) {
				const existingSources = store.inverse.get(target);
				if (existingSources) {
					for (const s of [...existingSources]) removeRelationEdge(store, s, target);
				}
			}
			let targets = store.forward.get(source);
			if (!targets) {
				targets = new Set();
				store.forward.set(source, targets);
			}
			targets.add(target);
			let sources = store.inverse.get(target);
			if (!sources) {
				sources = new Set();
				store.inverse.set(target, sources);
			}
			sources.add(source);
			const key = edgeKey(source, target);
			store.added.add(key);
			// Net-cancellation with queryRelationRemoved in the same tick.
			store.removed.delete(key);
			emitRelationAdded(store, source, target);
		},

		unrelate(source: EntityId, type: RelationType, target?: EntityId) {
			const store = getRelationStore(type);
			const targets = store.forward.get(source);
			if (!targets) return;
			if (target === undefined) {
				// Remove ALL of source's outgoing edges for this relation.
				for (const t of [...targets]) removeRelationEdge(store, source, t);
			} else if (targets.has(target)) {
				removeRelationEdge(store, source, target);
			}
		},

		getTargets(source: EntityId, type: RelationType): EntityId[] {
			const store = getRelationStore(type);
			const targets = store.forward.get(source);
			return targets ? [...targets] : [];
		},

		getTarget(source: EntityId, type: RelationType): EntityId | undefined {
			const store = getRelationStore(type);
			const targets = store.forward.get(source);
			if (!targets) return undefined;
			for (const t of targets) return t;
			return undefined;
		},

		getSources(type: RelationType, target: EntityId): EntityId[] {
			const store = getRelationStore(type);
			const sources = store.inverse.get(target);
			return sources ? [...sources] : [];
		},

		// === Queries (cached) ===

		query(...types: (ComponentType | TagType | NotTerm)[]): QueryResult {
			if (types.length === 0) return [...alive];

			const key = getQueryKey(types);

			// Return from cache if available
			let cached = queryCache.get(key);
			if (cached) return [...cached];

			// Build cache on first call
			const compNames: string[] = [];
			const tagNames: string[] = [];
			const notCompNames: string[] = [];
			const notTagNames: string[] = [];
			for (const type of types) {
				if (type.__kind === 'component') compNames.push(type.name);
				else if (type.__kind === 'tag') tagNames.push(type.name);
				else if (type.type.__kind === 'component') notCompNames.push(type.type.name);
				else notTagNames.push(type.type.name);
			}
			if (compNames.length === 0 && tagNames.length === 0) {
				throw new Error(
					'query() requires at least one positive term; a query of only Not() terms would scan every entity',
				);
			}

			cached = buildQueryResult(compNames, tagNames, notCompNames, notTagNames);
			queryCache.set(key, cached);
			queryKeyTypes.set(key, {
				components: compNames,
				tags: tagNames,
				notComponents: notCompNames,
				notTags: notTagNames,
			});

			// Register reverse index so cache updates on add/remove — negated
			// names too, so adding the negated type evicts the entity (and
			// removing it re-admits)
			for (const name of [...compNames, ...tagNames, ...notCompNames, ...notTagNames]) {
				let queryKeys = typeToQueries.get(name);
				if (!queryKeys) {
					queryKeys = new Set();
					typeToQueries.set(name, queryKeys);
				}
				queryKeys.add(key);
			}

			return [...cached];
		},

		queryChanged(type: ComponentType): QueryResult {
			const store = getComponentStore(type);
			return [...store.dirty];
		},

		queryAdded(type: ComponentType): QueryResult {
			const store = getComponentStore(type);
			return [...store.added];
		},

		queryRemoved(type: ComponentType): QueryResult {
			const store = getComponentStore(type);
			return [...store.removed];
		},

		queryTagged(type: TagType): QueryResult {
			const store = getTagStore(type);
			return [...store.entities];
		},

		queryAddedTag(type: TagType): QueryResult {
			const store = getTagStore(type);
			return [...store.added];
		},

		queryRemovedTag(type: TagType): QueryResult {
			const store = getTagStore(type);
			return [...store.removed];
		},

		queryRelation(type: RelationType): RelationEdge[] {
			const store = getRelationStore(type);
			const result: [EntityId, EntityId][] = [];
			for (const [source, targets] of store.forward) {
				for (const target of targets) result.push([source, target]);
			}
			return result;
		},

		queryRelationAdded(type: RelationType): RelationEdge[] {
			const store = getRelationStore(type);
			return decodeEdgeKeys(store.added);
		},

		queryRelationRemoved(type: RelationType): RelationEdge[] {
			const store = getRelationStore(type);
			return decodeEdgeKeys(store.removed);
		},

		// === Resources ===

		getResource<T>(type: ResourceType<T>): T {
			const existing = resourceTypes.get(type.name);
			if (existing) {
				if (existing !== (type as ResourceType)) {
					throw new Error(
						`Resource name collision: "${type.name}" is already registered to a different ResourceType. ` +
							`Names must be unique across all defineResource() calls.`,
					);
				}
			} else {
				resourceTypes.set(type.name, type as ResourceType);
			}
			if (!resources.has(type.name)) {
				resources.set(type.name, instantiateDefaults(type.defaults));
			}
			return resources.get(type.name) as T;
		},

		setResource<T>(type: ResourceType<T>, data: Partial<T>) {
			const existing = world.getResource(type);
			Object.assign(existing as Record<string, unknown>, data);
		},

		// === Events ===

		onComponentChanged<T>(
			type: ComponentType<T>,
			handler: ComponentChangedHandler<T>,
			entityId?: EntityId,
		): Unsubscribe {
			const store = getComponentStore(type);
			const key: EntityId | '*' = entityId ?? '*';
			let handlers = store.handlers.get(key);
			if (!handlers) {
				handlers = new Set();
				store.handlers.set(key, handlers);
			}
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},

		onComponentRemoved<T>(
			type: ComponentType<T>,
			handler: ComponentRemovedHandler<T>,
			entityId?: EntityId,
		): Unsubscribe {
			const store = getComponentStore(type);
			const key: EntityId | '*' = entityId ?? '*';
			let handlers = store.removedHandlers.get(key);
			if (!handlers) {
				handlers = new Set();
				store.removedHandlers.set(key, handlers);
			}
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},

		onTagAdded(type: TagType, handler: TagChangedHandler, entityId?: EntityId): Unsubscribe {
			const store = getTagStore(type);
			const key: EntityId | '*' = entityId ?? '*';
			let handlers = store.addedHandlers.get(key);
			if (!handlers) {
				handlers = new Set();
				store.addedHandlers.set(key, handlers);
			}
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},

		onTagRemoved(type: TagType, handler: TagChangedHandler, entityId?: EntityId): Unsubscribe {
			const store = getTagStore(type);
			const key: EntityId | '*' = entityId ?? '*';
			let handlers = store.removedHandlers.get(key);
			if (!handlers) {
				handlers = new Set();
				store.removedHandlers.set(key, handlers);
			}
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},

		onRelationAdded(
			type: RelationType,
			handler: RelationHandler,
			sourceId?: EntityId,
		): Unsubscribe {
			const store = getRelationStore(type);
			const key: EntityId | '*' = sourceId ?? '*';
			let handlers = store.addedHandlers.get(key);
			if (!handlers) {
				handlers = new Set();
				store.addedHandlers.set(key, handlers);
			}
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},

		onRelationRemoved(
			type: RelationType,
			handler: RelationHandler,
			sourceId?: EntityId,
		): Unsubscribe {
			const store = getRelationStore(type);
			const key: EntityId | '*' = sourceId ?? '*';
			let handlers = store.removedHandlers.get(key);
			if (!handlers) {
				handlers = new Set();
				store.removedHandlers.set(key, handlers);
			}
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},

		onEntityCreated(callback: (entity: EntityId) => void): Unsubscribe {
			createListeners.add(callback);
			return () => {
				createListeners.delete(callback);
			};
		},

		onEntityDestroyed(callback: (entity: EntityId) => void): Unsubscribe {
			destroyListeners.add(callback);
			return () => {
				destroyListeners.delete(callback);
			};
		},

		onFrame(handler: FrameHandler): Unsubscribe {
			frameHandlers.add(handler);
			return () => frameHandlers.delete(handler);
		},

		// === Introspection ===

		getAllEntities(): EntityId[] {
			return [...alive];
		},

		getRegisteredComponents(): ComponentType[] {
			const result: ComponentType[] = [];
			for (const store of components.values()) result.push(store.type);
			return result;
		},

		getRegisteredTags(): TagType[] {
			const result: TagType[] = [];
			for (const store of tags.values()) result.push(store.type);
			return result;
		},

		getRegisteredResources(): ResourceType[] {
			return [...resourceTypes.values()];
		},

		getComponentsOf(entity: EntityId): ComponentType[] {
			const result: ComponentType[] = [];
			for (const store of components.values()) {
				if (store.data.has(entity)) result.push(store.type);
			}
			return result;
		},

		getTagsOf(entity: EntityId): TagType[] {
			const result: TagType[] = [];
			for (const store of tags.values()) {
				if (store.entities.has(entity)) result.push(store.type);
			}
			return result;
		},

		// Frame lifecycle
		clearDirty() {
			for (const store of components.values()) {
				store.dirty.clear();
				store.added.clear();
				store.removed.clear();
			}
			for (const store of tags.values()) {
				store.added.clear();
				store.removed.clear();
			}
			for (const store of relations.values()) {
				store.added.clear();
				store.removed.clear();
			}
		},

		incrementTick() {
			currentTick++;
		},

		emitFrame() {
			for (const h of frameHandlers) h();
		},
	};

	return world;
}
