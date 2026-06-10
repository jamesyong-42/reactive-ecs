/** Opaque entity identifier — sequential integer internally */
export type EntityId = number;

/** Component type definition created by defineComponent() */
export interface ComponentType<T = unknown> {
	readonly name: string;
	readonly defaults: T;
	/** Internal brand to distinguish components from tags */
	readonly __kind: 'component';
}

/** Tag type definition created by defineTag() — marker with no data */
export interface TagType {
	readonly name: string;
	readonly __kind: 'tag';
}

/** Negated query term created by Not() — matches entities WITHOUT the wrapped type */
export interface NotTerm {
	readonly type: ComponentType | TagType;
	readonly __kind: 'not';
}

/**
 * Options for defineRelation() — exclusivity bounds and the target-destroy policy.
 * The two exclusivity bounds are independent: a `ChildOf` relation is
 * `sourceExclusive` only (one parent, many children); a true 1:1 ownership
 * edge sets both.
 */
export interface RelationOptions {
	/** At most one target per source — relating to a second target replaces the first. Default: false. */
	readonly sourceExclusive?: boolean;
	/** At most one source per target — relating from a second source replaces the first. Default: false. */
	readonly targetExclusive?: boolean;
	/**
	 * What happens to each source when its target is destroyed, applied after
	 * the destroy sweep completes: `'clear'` drops the edge and leaves the
	 * source alone, `'cascade'` destroys the source too, `{ tag }` adds the tag
	 * to the source. Default: `'clear'`.
	 */
	readonly onTargetDestroy?: 'cascade' | 'clear' | { readonly tag: TagType };
}

/**
 * Relation type definition created by defineRelation() — a managed,
 * inverse-indexed, lifecycle-cleaned edge between two entities.
 */
export interface RelationType {
	readonly name: string;
	/** Normalized options — defaults applied by defineRelation(). */
	readonly options: Readonly<Required<RelationOptions>>;
	/** Internal brand to distinguish relations from components/tags */
	readonly __kind: 'relation';
}

/** Resource type definition created by defineResource() */
export interface ResourceType<T = unknown> {
	readonly name: string;
	readonly defaults: T;
	readonly __kind: 'resource';
}

/** System definition created by defineSystem() */
export interface SystemDef {
	readonly name: string;
	/**
	 * Pipeline phase this system runs in (consumed by `PhasedScheduler`; ignored
	 * by `SystemScheduler`). Phase membership is validated by the scheduler at
	 * register time against its configured phase list. Cross-phase `after` /
	 * `before` constraints are rejected at first execute — use phase order for
	 * cross-phase ordering.
	 */
	readonly phase?: string;
	readonly after?: string | string[];
	readonly before?: string | string[];
	/**
	 * Run condition — evaluated immediately before the system would run, inside
	 * the same tick (so it sees writes from systems that ran earlier this tick
	 * via the per-tick buffers); return false to skip this tick. The library
	 * attaches no change-detection policy — the predicate is yours. The classic
	 * shape: `runIf: (w) => w.queryChanged(Position).length > 0`. Caveat:
	 * per-tick buffers are cleared at end of tick, so order systems that lazily
	 * READ a type after the systems that WRITE it (phases make this natural) —
	 * a write that happens after the guard ran this tick is invisible to next
	 * tick's guard.
	 */
	readonly runIf?: (world: World) => boolean;
	execute: (world: World) => void;
}

/** Query result — array of entity IDs */
export type QueryResult = EntityId[];

/** Component initializer for entity creation */
export type ComponentInit = [ComponentType<unknown>, unknown] | [TagType];

/**
 * Event handler types. Payloads are typed `Readonly` for the same reason
 * reads are: the objects are live (or shared-with-live) store values, and
 * writes must go through the world API. This is top-level, compile-time
 * friction — not runtime immutability.
 */
export type ComponentChangedHandler<T = unknown> = (
	entityId: EntityId,
	prev: Readonly<T> | undefined,
	next: Readonly<T>,
) => void;

/**
 * Fired synchronously when a component is being removed from an entity —
 * either via `removeComponent` or as part of `destroyEntity` teardown.
 * Receives the value about to be discarded as `prev`. Fires BEFORE the
 * component data is deleted, so the value is still readable in the store.
 */
export type ComponentRemovedHandler<T = unknown> = (entityId: EntityId, prev: Readonly<T>) => void;

export type TagChangedHandler = (entityId: EntityId) => void;

/**
 * Fired synchronously inside `setResource`, AFTER the shallow merge is
 * applied. `prev` is a top-level snapshot of the value before the merge —
 * the object itself never aliases `next`, though nested values the merge
 * didn't replace are shared with it. That sharing is safe: every write path
 * clones incoming plain data, and stored nested values are only ever
 * replaced, never mutated in place. Handlers can read `world.mutationOrigin`
 * to see the origin of the mutating call.
 */
export type ResourceChangedHandler<T = unknown> = (prev: Readonly<T>, next: Readonly<T>) => void;

/**
 * Fired synchronously when a relation edge is added or removed. Removal
 * handlers also fire for each edge torn down by `destroyEntity` of either
 * endpoint — during the destroy sweep the dying entity's components and tags
 * are still readable, but handlers must not mutate the world mid-destroy.
 */
export type RelationHandler = (source: EntityId, target: EntityId) => void;

/**
 * Filter for relation observers. A bare `EntityId` means source — the
 * original third-parameter shape, kept for back-compat. `{ target }` fires
 * only for edges pointing at that target (the parent-watches-children case);
 * `{ source, target }` requires both endpoints to match — the exact edge.
 */
export type RelationFilter = EntityId | { source?: EntityId; target?: EntityId };

/** A single relation edge — `[source, target]`. */
export type RelationEdge = readonly [EntityId, EntityId];

export type FrameHandler = () => void;

export type Unsubscribe = () => void;

/** The World interface -- core ECS container managing entities, components, tags, and resources. */
export interface World {
	/** Current tick number, incremented each frame. */
	readonly currentTick: number;
	/** Number of live entities. */
	readonly entityCount: number;
	/**
	 * Origin tag of the current mutation window — `undefined` outside any
	 * `withOrigin` window, i.e. the implicit "local" origin. Because every
	 * observer in this library fires synchronously inside the mutating call, a
	 * handler reading this always sees the origin of exactly the mutation that
	 * fired it. Readable anywhere, not just in handlers.
	 */
	readonly mutationOrigin: string | symbol | undefined;

	// Entity lifecycle

	/** Creates a new entity and returns its ID. */
	createEntity(): EntityId;
	/**
	 * Creates an entity with a caller-chosen id — the restore primitive for
	 * id-preserving deserialization. Throws if `id` is not a positive integer,
	 * is already alive, or is below the internal id counter (ids are never
	 * reused, so restore must create entities in ascending id order). On
	 * success the counter advances to `id + 1` and `onEntityCreated` fires —
	 * observably identical to a `createEntity()` that landed on `id`.
	 */
	createEntityWithId(id: EntityId): EntityId;
	/**
	 * Restores the internal id counter exactly, so subsequent `createEntity()`
	 * calls allocate from `n`. The counter only moves forward — throws if `n`
	 * is not an integer or is below the current counter. Call this after an
	 * ascending `createEntityWithId` restore loop: the saved counter can
	 * legitimately exceed the highest restored id (entities destroyed before
	 * the save consumed ids), and restoring it keeps stale references stale
	 * forever instead of letting their ids be re-issued.
	 */
	setNextEntityId(n: number): void;
	/**
	 * Destroys an entity and removes all its components, tags, and relation
	 * edges (as source or target — applying each relation's `onTargetDestroy`
	 * policy after teardown completes).
	 */
	destroyEntity(id: EntityId): void;
	/** Checks if an entity ID is still alive. */
	entityExists(id: EntityId): boolean;

	// Mutation origin

	/**
	 * Tags every mutation made synchronously inside `fn` with `origin`, readable
	 * by handlers via `mutationOrigin` — the echo-suppression primitive for
	 * observe-and-mutate modules (sync adapters, undo journals). The library
	 * attaches no semantics to any origin; the vocabulary is yours (symbols
	 * recommended). Throws unless `origin` is a string or symbol, keeping
	 * `undefined` unforgeable as "no origin". Re-entrant: nested calls stack,
	 * the innermost origin wins, and exiting restores the enclosing one — also
	 * on throw. Returns `fn`'s return value. Synchronous only: if `fn` is
	 * async, mutations after the first `await` are NOT tagged — async
	 * continuations must re-enter `withOrigin`. `destroyEntity` cascades
	 * (teardown events and relation policy effects) inherit the origin active
	 * at the `destroyEntity` call site. Per-tick buffers (`queryChanged` etc.)
	 * stay origin-blind.
	 */
	withOrigin<T>(origin: string | symbol, fn: () => T): T;

	// Component access

	/**
	 * Attaches a component to an entity — attach-or-replace. The value is
	 * `data` merged over the type's defaults; partial initialization is safe,
	 * and omitted data attaches pure defaults. When the entity already has the
	 * component, the existing value is replaced: observers receive the existing
	 * value as `prev` and the entity lands in the `queryChanged` buffer only —
	 * `prev === undefined` in observers reliably means first attach.
	 */
	addComponent<T>(entity: EntityId, type: ComponentType<T>, data?: Partial<T>): void;
	/** Removes a component from an entity. */
	removeComponent<T>(entity: EntityId, type: ComponentType<T>): void;
	/**
	 * Reads a component from an entity. Returns undefined if not present.
	 * The returned object is the live store value typed read-only; write
	 * through `patchComponent` / `addComponent`.
	 */
	getComponent<T>(entity: EntityId, type: ComponentType<T>): Readonly<T> | undefined;
	/** Checks if an entity has a component. */
	hasComponent(entity: EntityId, type: ComponentType): boolean;
	/**
	 * Strict shallow-merge update of an existing component: one level deep,
	 * nested objects in `data` replace wholesale. Incoming plain data is
	 * defensively cloned; observers receive a top-level snapshot of the prior
	 * value as `prev`, and the entity lands in the `queryChanged` buffer.
	 * Non-creating by design — absence is never silent: throws if the entity
	 * is dead, and throws if the entity is alive but lacks the component (use
	 * `addComponent` to attach). For writes that may race a destroy (async
	 * callbacks, timers), the idiomatic guard is
	 * `if (world.entityExists(id)) world.patchComponent(id, Type, data)`.
	 */
	patchComponent<T>(entity: EntityId, type: ComponentType<T>, data: Partial<T>): void;

	// Tag access

	/** Adds a boolean tag to an entity. */
	addTag(entity: EntityId, type: TagType): void;
	/** Removes a tag from an entity. */
	removeTag(entity: EntityId, type: TagType): void;
	/** Checks if an entity has a tag. */
	hasTag(entity: EntityId, type: TagType): boolean;

	// Relation access

	/**
	 * Adds a relation edge from `source` to `target`. Throws if source or
	 * target is not alive — a born-dangling edge is impossible. No-op if the
	 * exact edge already exists. If an exclusivity bound would be violated,
	 * the existing edge is replaced: removed-then-added events fire, mirroring
	 * addComponent overwrite semantics.
	 */
	relate(source: EntityId, type: RelationType, target: EntityId): void;
	/**
	 * Removes the edge from `source` to `target` — or, with `target` omitted,
	 * ALL of source's outgoing edges for this relation. No-op if absent.
	 */
	unrelate(source: EntityId, type: RelationType, target?: EntityId): void;
	/** Returns the targets `source` points at via this relation. `[]` if none. */
	getTargets(source: EntityId, type: RelationType): EntityId[];
	/** Returns source's single target — convenience for sourceExclusive relations. */
	getTarget(source: EntityId, type: RelationType): EntityId | undefined;
	/** Returns the sources pointing at `target` — the always-coherent inverse. `[]` if none. */
	getSources(type: RelationType, target: EntityId): EntityId[];

	// Queries

	/** Returns entity IDs matching all positive types and none of the Not() types. */
	query(...types: (ComponentType | TagType | NotTerm)[]): QueryResult;
	/** Returns entities whose component changed this tick. */
	queryChanged(type: ComponentType): QueryResult;
	/** Returns entities that received this component this tick. */
	queryAdded(type: ComponentType): QueryResult;
	/**
	 * Returns entities that lost this component this tick — via `removeComponent`
	 * or `destroyEntity`. Mirror of `queryAdded`. Net-cancels with `addComponent`
	 * in the same tick.
	 */
	queryRemoved(type: ComponentType): QueryResult;
	/** Returns all entities with a specific tag. */
	queryTagged(type: TagType): QueryResult;
	/**
	 * Returns entities that gained this tag this tick. Mirror of `queryAdded`
	 * for tags. Net-cancels with `removeTag` in the same tick.
	 */
	queryAddedTag(type: TagType): QueryResult;
	/**
	 * Returns entities that lost this tag this tick — via `removeTag` or
	 * `destroyEntity`. Net-cancels with `addTag` in the same tick.
	 */
	queryRemovedTag(type: TagType): QueryResult;
	/** Returns all live edges of a relation as `[source, target]` pairs. */
	queryRelation(type: RelationType): RelationEdge[];
	/**
	 * Returns edges added this tick. Mirror of `queryAdded` for relations.
	 * Net-cancels with `unrelate` of the same edge in the same tick.
	 */
	queryRelationAdded(type: RelationType): RelationEdge[];
	/**
	 * Returns edges removed this tick — via `unrelate`, exclusivity
	 * replacement, or `destroyEntity` of either endpoint. Net-cancels with
	 * `relate` of the same edge in the same tick.
	 */
	queryRelationRemoved(type: RelationType): RelationEdge[];
	/**
	 * Returns resource types whose `setResource` was called this tick, in
	 * first-changed order. Mirror of `queryChanged` for resources. Lazy
	 * creation via `getResource` is not a change — only `setResource` counts.
	 */
	queryChangedResources(): ResourceType[];

	// Resources

	/**
	 * Reads a singleton resource. The returned object is the live store value
	 * typed read-only; write through `setResource`.
	 */
	getResource<T>(type: ResourceType<T>): Readonly<T>;
	/** Partially updates a singleton resource (shallow merge). */
	setResource<T>(type: ResourceType<T>, data: Partial<T>): void;

	// Events

	/** Subscribes to component changes, optionally filtered to a single entity. */
	onComponentChanged<T>(
		type: ComponentType<T>,
		handler: ComponentChangedHandler<T>,
		entityId?: EntityId,
	): Unsubscribe;
	/**
	 * Subscribes to component removals, optionally filtered to a single entity.
	 * Handler fires synchronously before the data is deleted, so `prev` is the
	 * value being torn down. Also fires for each component an entity owned at
	 * the moment `destroyEntity` is called.
	 */
	onComponentRemoved<T>(
		type: ComponentType<T>,
		handler: ComponentRemovedHandler<T>,
		entityId?: EntityId,
	): Unsubscribe;
	/** Subscribes to tag additions, optionally filtered to a single entity. */
	onTagAdded(type: TagType, handler: TagChangedHandler, entityId?: EntityId): Unsubscribe;
	/** Subscribes to tag removals, optionally filtered to a single entity. */
	onTagRemoved(type: TagType, handler: TagChangedHandler, entityId?: EntityId): Unsubscribe;
	/**
	 * Subscribes to relation edge additions, optionally filtered: a bare
	 * `EntityId` means source (back-compat), `{ target }` fires only for edges
	 * pointing at that target, and `{ source, target }` matches only the exact
	 * edge. Handlers fire per-source, then per-target, then wildcard.
	 */
	onRelationAdded(
		type: RelationType,
		handler: RelationHandler,
		filter?: RelationFilter,
	): Unsubscribe;
	/**
	 * Subscribes to relation edge removals, optionally filtered like
	 * `onRelationAdded`: bare `EntityId` = source, `{ target }` = edges into
	 * that target, `{ source, target }` = the exact edge. Also fires for each
	 * edge torn down by `destroyEntity` of either endpoint — the dying entity's
	 * components and tags are still readable at fire-time, but handlers must
	 * not mutate mid-destroy.
	 */
	onRelationRemoved(
		type: RelationType,
		handler: RelationHandler,
		filter?: RelationFilter,
	): Unsubscribe;
	/**
	 * Subscribes to resource changes — fires synchronously inside `setResource`
	 * after the merge is applied, with a pre-merge snapshot as `prev` and the
	 * live value as `next`. Resources are singletons, so there is no per-entity
	 * filter. Handlers can read `world.mutationOrigin`. Subscribing lazily
	 * creates the resource from its defaults, like `getResource`.
	 */
	onResourceChanged<T>(type: ResourceType<T>, handler: ResourceChangedHandler<T>): Unsubscribe;
	/** Subscribes to entity creation events. */
	onEntityCreated(callback: (entity: EntityId) => void): Unsubscribe;
	/** Subscribes to entity destruction events. */
	onEntityDestroyed(callback: (entity: EntityId) => void): Unsubscribe;
	/** Subscribes to frame-end events (emitted after each tick). */
	onFrame(handler: FrameHandler): Unsubscribe;

	// Introspection — list entities and types

	/** Returns all live entity IDs. */
	getAllEntities(): EntityId[];
	/** Returns all ComponentTypes that have ever had a store created in this world. */
	getRegisteredComponents(): ComponentType[];
	/** Returns all TagTypes that have ever had a store created in this world. */
	getRegisteredTags(): TagType[];
	/** Returns all ResourceTypes that have ever been accessed in this world. */
	getRegisteredResources(): ResourceType[];
	/** Returns the ComponentTypes currently attached to an entity. */
	getComponentsOf(entity: EntityId): ComponentType[];
	/** Returns the TagTypes currently attached to an entity. */
	getTagsOf(entity: EntityId): TagType[];

	// Frame lifecycle (used by engine after tick)

	/** Clears per-frame dirty tracking state. */
	clearDirty(): void;
	/** Increments the tick counter. */
	incrementTick(): void;
	/** Emits frame-end events to all onFrame subscribers. */
	emitFrame(): void;
}
