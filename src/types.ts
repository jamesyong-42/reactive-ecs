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
	/**
	 * Names of systems this one must run after / before. Validated lazily at
	 * the first `execute()` (and re-validated after every register/remove), so
	 * systems can be registered in any order — but a constraint naming a
	 * system that is never registered throws, naming both parties. Silent
	 * tolerance would let a typo quietly reorder the pipeline. Optional
	 * cross-configuration ordering belongs to phases, not constraints.
	 */
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

/** Options for createWorld(). */
export interface CreateWorldOptions {
	/**
	 * Dev-mode option: deep-freeze exactly what the world clones — plain
	 * objects and arrays at any depth, never class instances — wherever
	 * cloned data enters a store (addComponent, patchComponent, resource
	 * instantiation, setResource). Clone and freeze are two enforcements of
	 * the same ownership boundary: plain data crossing the API is owned by
	 * the world. With freeze on, in-place mutation of a read then throws in
	 * strict mode instead of silently bypassing change tracking.
	 * Default: false.
	 */
	readonly freeze?: boolean;
	/**
	 * Max depth of synchronous handler re-entrancy before the world throws a
	 * loud cycle error instead of overflowing the stack. A handler that mutates
	 * the world re-triggers handlers synchronously; an unbounded handler→mutate
	 * →handler feedback loop would otherwise be a stack overflow. Default: 1000.
	 */
	readonly maxReentrancyDepth?: number;
}

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
 * are still readable, but mutating the world from a handler mid-sweep throws.
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

/** A before/after value pair for a changed component or resource (RFC-006). */
export interface Change<T = unknown> {
	readonly prev: Readonly<T>;
	readonly next: Readonly<T>;
}

/**
 * The net change detection over a tick window — the value-carrying successor to
 * the per-tick buffer queries (RFC-006). `world.changes()` returns this live view
 * of every change since the current tick began, by the same net-transition
 * partition the buffers used:
 *
 *   absent→present = added · present→present (≥1 write) = changed ·
 *   present→absent = removed · absent→absent = invisible.
 *
 * The accessor verbs mirror the buffer queries one-for-one — `added(C)` is the
 * value-carrying successor to `queryAdded(C)`. Every value is a zero-copy
 * reference to an immutable store snapshot; each accessor CALL materializes a
 * fresh container, so iterating one while the loop body mutates the world is
 * safe, and a later call reflects later writes. Not retainable across a tick.
 */
export interface WorldChanges {
	/** The tick this window belongs to. */
	readonly tick: number;
	/** Entities net-created this window (created-then-destroyed cancels). */
	readonly created: ReadonlySet<EntityId>;
	/** Entities net-destroyed this window (alive at window start). */
	readonly destroyed: ReadonlySet<EntityId>;

	/** Components attached this window (absent→present); value = current. */
	added<T>(type: ComponentType<T>): ReadonlyMap<EntityId, Readonly<T>>;
	/** Components written this window (present→present); `{ prev, next }`. */
	changed<T>(type: ComponentType<T>): ReadonlyMap<EntityId, Change<T>>;
	/**
	 * Components removed this window (present→absent); value = the WINDOW-START
	 * value (so `applyChanges(invertChanges(...))` restores pre-window state).
	 * The value of a component *replaced* mid-window is NOT here — net diffs
	 * cannot serve that; use the synchronous `onComponentRemoved` event for
	 * cleanup of every intermediate value.
	 */
	removed<T>(type: ComponentType<T>): ReadonlyMap<EntityId, Readonly<T>>;

	/** Tags added this window (absent→present). */
	addedTag(type: TagType): ReadonlySet<EntityId>;
	/** Tags removed this window (present→absent). */
	removedTag(type: TagType): ReadonlySet<EntityId>;

	/** Relation edges added this window (absent→present). */
	addedRelation(type: RelationType): readonly RelationEdge[];
	/** Relation edges removed this window (present→absent). */
	removedRelation(type: RelationType): readonly RelationEdge[];

	/** Resources set this window, `{ prev, next }` keyed by resource type. */
	changedResources(): ReadonlyMap<ResourceType<unknown>, Change<unknown>>;

	/** True when nothing changed this window. */
	isEmpty(): boolean;
}

/**
 * Mutation attribution (RFC-003): a string/symbol set via `withOrigin`, or
 * `undefined` for the implicit local origin. The unit a `DeliveredChanges`
 * carries — every mutation in a delivered run shares one origin.
 */
export type Origin = string | symbol | undefined;

/**
 * What `onChanges` delivers (RFC-006): a sealed, origin-homogeneous run of
 * changes. It IS a `WorldChanges` — same accessors, same partition — and adds
 * the run's attribution. `origin` is well-defined because the run is
 * homogeneous (`undefined` = implicit local, never "mixed": an origin change
 * seals the run). Unlike the live `changes()` view, a delivered run is an
 * immutable snapshot frozen at seal time and safe to retain (undo, sync).
 */
export interface DeliveredChanges extends WorldChanges {
	readonly origin: Origin;
}

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
	 * policy after teardown completes). Handlers fired during the teardown
	 * sweep may read the dying entity but not mutate the world — every
	 * mutating method throws until the sweep completes. React via the removed
	 * buffers or an `onTargetDestroy` policy instead.
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
	 * Attaches a component to an entity — attach-or-replace (upsert). The
	 * value is `data` merged over the type's defaults; partial initialization
	 * is safe, and omitted data attaches pure defaults. When the entity
	 * already has the component, the existing value is replaced: observers
	 * receive the existing value as `prev` — `prev === undefined` in observers
	 * reliably means first attach. Buffers record the NET transition since the
	 * last clearDirty(): absent then → `queryAdded`, present then →
	 * `queryChanged`.
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
	 * value as `prev`. The entity lands in the buffer matching its net
	 * transition: `queryChanged` when the component was present at the last
	 * `clearDirty()`, while a component attached this tick stays in
	 * `queryAdded`.
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
	/**
	 * Returns the sources pointing at `target` — the always-coherent inverse.
	 * `[]` if none. Entity-first like every per-entity read/write:
	 * `(entity, type, ...)`.
	 */
	getSources(target: EntityId, type: RelationType): EntityId[];

	// Queries

	/** Returns entity IDs matching all positive types and none of the Not() types. */
	query(...types: (ComponentType | TagType | NotTerm)[]): QueryResult;
	/**
	 * Drops the cache entry and reverse-index registrations for this exact
	 * query signature (order-insensitive, like `query`). No-op if the
	 * signature was never queried. A later `query` with the same signature
	 * rebuilds the cache with one scan over the smallest candidate store —
	 * that rebuild is the only full-scan path in the library; once rebuilt,
	 * the entry is maintained incrementally again.
	 */
	disposeQuery(...types: (ComponentType | TagType | NotTerm)[]): void;
	/**
	 * The net change detection for the current tick — every component, tag,
	 * relation, and resource change since the tick began, carrying values
	 * (RFC-006). The value-carrying successor to the per-tick buffer queries:
	 * `world.changes().added(C)` replaces `world.queryAdded(C)`, etc. A live
	 * view whose accessors materialize stable per-call snapshots; not retainable
	 * across a tick.
	 */
	changes(): WorldChanges;
	/**
	 * Subscribe to delivered change detection (RFC-006). The handler fires once
	 * per sealed origin-run, in capture order, when the tick advances via
	 * `tickWorld` — once per tick in the common single-origin case, and once per
	 * contiguous same-origin run when origins interleave mid-tick. The world is
	 * final and coherent during delivery; handlers may read and may mutate (their
	 * writes apply immediately and are delivered on the NEXT tick, never nested
	 * into this one). Delivery is serial and exactly-once: every handler receives
	 * every run even if an earlier handler throws (errors are collected and
	 * rethrown as an AggregateError after the drain, and the frame still advances).
	 * Returns an unsubscribe function.
	 */
	onChanges(handler: (changes: DeliveredChanges) => void): Unsubscribe;
	/** Returns all entities with a specific tag. */
	queryTagged(type: TagType): QueryResult;
	/** Returns all live edges of a relation as `[source, target]` pairs. */
	queryRelation(type: RelationType): RelationEdge[];

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
	 * components and tags are still readable at fire-time, but mutating the
	 * world mid-sweep throws.
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
	/** Returns all RelationTypes that have ever had a store created in this world. */
	getRegisteredRelations(): RelationType[];
	/** Returns all ResourceTypes that have ever been accessed in this world. */
	getRegisteredResources(): ResourceType[];
	/** Returns the ComponentTypes currently attached to an entity. */
	getComponentsOf(entity: EntityId): ComponentType[];
	/** Returns the TagTypes currently attached to an entity. */
	getTagsOf(entity: EntityId): TagType[];
}
