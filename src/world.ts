import type {
	ComponentChangedHandler,
	ComponentType,
	EntityId,
	FrameHandler,
	QueryResult,
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
	handlers: Map<EntityId | '*', Set<ComponentChangedHandler<T>>>;
}

/** Internal storage for a single tag type */
interface TagStore {
	/** Identity anchor — used to detect name collisions across defineTag() calls. */
	type: TagType;
	entities: Set<EntityId>;
	addedHandlers: Map<EntityId | '*', Set<TagChangedHandler>>;
	removedHandlers: Map<EntityId | '*', Set<TagChangedHandler>>;
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
	// Resources: one value per resource type
	const resources = new Map<string, unknown>();
	// Identity anchors for resources — same purpose as ComponentStore.type
	const resourceTypes = new Map<string, ResourceType>();
	// Frame handlers
	const frameHandlers = new Set<FrameHandler>();
	// Destroy listeners — called before components/tags are removed
	const destroyListeners = new Set<(entity: EntityId) => void>();

	// === Query cache ===
	// Key: sorted type names joined by '\0'
	// Value: live Set<EntityId> of entities matching all types in the key
	const queryCache = new Map<string, Set<EntityId>>();
	// Reverse index: typeName → Set<queryKey> — which cached queries use this type
	const typeToQueries = new Map<string, Set<string>>();
	// Store the type names per query key for re-evaluation
	const queryKeyTypes = new Map<string, { components: string[]; tags: string[] }>();

	function getQueryKey(types: (ComponentType | TagType)[]): string {
		return types
			.map((t) => t.name)
			.sort()
			.join('\0');
	}

	function buildQueryResult(compNames: string[], tagNames: string[]): Set<EntityId> {
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
			if (matchesQuery(entity, compNames, tagNames)) {
				result.add(entity);
			}
		}
		return result;
	}

	function matchesQuery(entity: EntityId, compNames: string[], tagNames: string[]): boolean {
		for (const name of compNames) {
			const store = components.get(name);
			if (!store || !store.data.has(entity)) return false;
		}
		for (const name of tagNames) {
			const store = tags.get(name);
			if (!store || !store.entities.has(entity)) return false;
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
			if (matchesQuery(entity, types.components, types.tags)) {
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
			handlers: new Map(),
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
			addedHandlers: new Map(),
			removedHandlers: new Map(),
		};
		tags.set(type.name, store);
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
			return id;
		},

		destroyEntity(id: EntityId) {
			if (!alive.has(id)) return;
			// Notify destroy listeners BEFORE removing components/tags
			// so callbacks can still read the entity's data
			for (const listener of destroyListeners) listener(id);
			alive.delete(id);
			// Remove from all cached queries
			removeCachesForEntity(id);
			// Remove all components
			for (const store of components.values()) {
				store.data.delete(id);
				store.dirty.delete(id);
				store.added.delete(id);
				store.handlers.delete(id);
			}
			// Remove all tags
			for (const store of tags.values()) {
				store.entities.delete(id);
				store.addedHandlers.delete(id);
				store.removedHandlers.delete(id);
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
			// Update cached queries that include this component
			updateCachesForEntity(type.name, entity);
			emitComponentChanged(store, entity, undefined, merged);
		},

		removeComponent<T>(entity: EntityId, type: ComponentType<T>) {
			const store = getComponentStore(type);
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
			// Update cached queries that include this tag
			updateCachesForEntity(type.name, entity);
			emitTagAdded(store, entity);
		},

		removeTag(entity: EntityId, type: TagType) {
			const store = getTagStore(type);
			if (!store.entities.has(entity)) return;
			store.entities.delete(entity);
			// Update cached queries — entity may no longer match
			updateCachesForEntity(type.name, entity);
			emitTagRemoved(store, entity);
		},

		hasTag(entity: EntityId, type: TagType): boolean {
			const store = getTagStore(type);
			return store.entities.has(entity);
		},

		// === Queries (cached) ===

		query(...types: (ComponentType | TagType)[]): QueryResult {
			if (types.length === 0) return [...alive];

			const key = getQueryKey(types);

			// Return from cache if available
			let cached = queryCache.get(key);
			if (cached) return [...cached];

			// Build cache on first call
			const compNames: string[] = [];
			const tagNames: string[] = [];
			for (const type of types) {
				if (type.__kind === 'component') compNames.push(type.name);
				else tagNames.push(type.name);
			}

			cached = buildQueryResult(compNames, tagNames);
			queryCache.set(key, cached);
			queryKeyTypes.set(key, { components: compNames, tags: tagNames });

			// Register reverse index so cache updates on add/remove
			for (const name of [...compNames, ...tagNames]) {
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

		queryTagged(type: TagType): QueryResult {
			const store = getTagStore(type);
			return [...store.entities];
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

		// Frame lifecycle
		clearDirty() {
			for (const store of components.values()) {
				store.dirty.clear();
				store.added.clear();
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
