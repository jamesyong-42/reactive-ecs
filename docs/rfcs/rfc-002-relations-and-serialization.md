# RFC-002: First-Class Relations &amp; World Snapshot/Restore — Two Primitives the Consumer Cannot Build

- **Status**: Superseded — Request 1 by RFC-002.1 (relations, minimal subset), Request 2 by RFC-002.2 (id-preserving creation counter-proposal). Kept for the motivation census both successors reference.
- **Author**: James Yong — filed on behalf of `@jamesyong42/infinite-canvas`
- **Date**: 2026-06-06
- **Area**: World API · entity-to-entity references · destruction cleanup · per-tick query primitives · world serialization
- **Driver**: `@jamesyong42/infinite-canvas` v2 (clean-room interaction rebuild). The prototype hand-rolls the same two mechanisms ~15× and the production engine carries two latent correctness bugs that trace directly to their absence (`parentFrameActive` removal gap; `ParentFrame`/`ContainerChildren` dual-source-of-truth).
- **Scope**: **additive** — two independent feature requests in one document. Each ships on its own. Request 1 adds a new concept (relations); Request 2 adds a new capability (snapshot/restore) plus a small per-type serialization policy. Neither changes the shape of any existing API.

---

## Why one document, two requests

These are separable and can land in either order, but we're filing them together because **they interlock at exactly one point**: a relation is an entity-to-entity edge, and a saved world must round-trip those edges. Request 2 is what makes Request 1's edges survive a save/load; Request 1 is what lets Request 2 remap references automatically on import. We want the maintainer to see that seam before committing to either shape.

| | Request | One-line ask | Independently shippable? |
|---|---|---|---|
| **1** | First-class **relations** | A managed, indexed, lifecycle-aware entity reference with a configurable on-destroy policy | yes |
| **2** | World **snapshot/restore** | Serialize the whole world to plain data and restore it **preserving entity ids** | yes |

---

## The shared thesis: these are World-lifecycle concerns, not composition

RFC-001's non-goals drew a principled line: bundle-swap helpers and FSM machinery were pushed to user-land *because the consumer can build them* on top of the primitives — "the lib remains opinion-free." We agree with that line, and both requests here sit on the **other** side of it. The test we're applying:

> Can the consumer build this correctly in user-land using the public `World` API?

For relations and for serialization, the honest answer is **no** — not for ergonomic reasons, but because both depend on things the consumer structurally cannot reach:

- **Relations need `destroyEntity` to clean up edges.** `destroyEntity` lives on `World` (`world.ts:283`). A consumer can *react* to a destroy via `onEntityDestroyed`, but it can never *enforce* that every edge pointing at the dying entity is cleaned and its policy fired — the guarantee "no stale entity reference ever survives a destroy" can only be made by the owner of the lifecycle. (It also needs to participate in `clearDirty` (`world.ts:637`) to expose per-tick `added`/`removed` edge buffers — the closured frame buffers are private.)

- **Serialization needs to restore entities *with their original ids*.** `createEntity()` allocates a fresh monotonic id every time (`world.ts:277`) and there is no way to set the id counter. So a consumer can *serialize* by walking the introspection API, but it can never *restore* without renumbering every entity — which forces it to hand-remap every entity-typed field. The authoritative state (`components`, `tags`, `resources`, `alive`, `nextEntityId`) is entirely closed over inside `createWorld`; only the framework can reinstate it id-for-id.

This is precisely why these belong in reactive-ecs and not in infinite-canvas: the useful parts are the parts app code cannot guarantee globally.

---

# Request 1 — First-class relations

## Motivation

### infinite-canvas is already a relations system, hand-rolled

Every entity-to-entity link in the codebase is a typed `EntityId` field plus per-reader defensive checks. A representative census:

| Edge | Location | Shape | Inverse kept? | Integrity by hand? |
|---|---|---|---|---|
| `Capture.target` → widget | prototype `gesture.ts:49` | 1:1 | scanned | yes — `recognizerIntegrity` |
| `Watches.pointers[]` → pointer(s) | prototype `gesture.ts:48` | 1:N | scanned | yes — `recognizerIntegrity` |
| `Sequence.after` / `RequiresFail.other` → recognizer | prototype `gesture.ts:53-54` | 1:1 | no | yes — `dependencySystem` |
| `Follower.target` → pointer | prototype `components.ts:18` | 1:1 (+payload `tau`) | no | yes — `entityExists` ×3 |
| `ParentFrame.id` → container | engine `components.ts:61` | 1:1 | **yes, by hand** | cycle-guard |
| `Children.ids` / `ContainerChildren.ids` → children | engine `components.ts:64,74` | 1:N | **IS the hand-built inverse** | apply/revert + load sync |

The prototype's own comment names the pattern exactly: the bindings are *"lightweight relationships — typed `EntityId` refs … **NOT Flecs**"* (`gesture.ts:47`), and `recognizerIntegritySystem` is labelled *"our hand-rolled `OnDeleteTarget`"* (`gesture.ts:230`). Across the prototype there are **~12 `entityExists()` guards** — every reader of an edge re-proves the referent is alive before dereferencing. That is the tax for the store not knowing these fields are edges.

### Two concrete costs this imposes today

1. **Dual source of truth.** The production engine maintains a forward edge (`ParentFrame.id`) *and* a denormalized inverse (`Children` / `ContainerChildren`). Its own comment (`components.ts:66`): *"Redundant with `ParentFrame` (the inverse relation) but materialised … `applyMutation`/`revertMutation` keep the two in sync. Serialized; IDs are remapped alongside `ParentFrame` on load."* Two indexes, kept coherent by hand across mutation, undo, **and** serialization.

2. **A latent removal bug, self-documented.** `systems/parent-frame-active.ts:17` carries this note verbatim: *"`ParentFrame` removal is not handled here … `queryChanged` does not emit on `removeComponent` … the undo (`ParentFrame` removed, child returns to root) case was never actually covered."* RFC-001 gave us `queryRemoved` for components, which closes part of this — but the edge semantics (who pointed at the destroyed parent, and what should happen to them) still has to be reconstructed by hand. A managed relation with an `onTargetDestroy` policy makes that bug **unrepresentable**.

### What we cannot get from RFC-001 alone

RFC-001 completed the component/tag observability table — thank you, we depend on it. But an `EntityId` stored in a component field is opaque to the store: it's just a number. The store cannot index it, cannot maintain its inverse, cannot detect when the pointed-at entity dies, and cannot clean it up. Relations are the request to make that one number a *managed edge*.

## Proposed API

A relation is defined like a component, but it stores *edges between entities* instead of *data on an entity*:

```ts
const ChildOf = defineRelation('ChildOf', {
  sourceExclusive: true,           // ≤ 1 target per source — a child has one parent      (default: false)
  targetExclusive: false,          // ≤ 1 source per target — a parent has many children   (default: false)
  onTargetDestroy: 'clear',        // 'cascade' | 'clear' | 'keep' | { tag: TagType } | (ctx, src, tgt) => Effect[]  — see TargetPolicy
  payload: { /* optional per-edge data, like a component's defaults */ },
  serialize: true,                 // include edges in world.snapshot() (default: true) — see Request 2
});
// The target→sources reverse index is ALWAYS maintained internally — target-destroy cleanup needs it,
// so there is deliberately no option to disable it (an early draft's `inverse: false` was a bug). The two
// cardinality bounds are independent: `targetExclusive` is what RFC-012 drag-ownership needs — a
// `Dragging(pointer → widget)` edge is BOTH sourceExclusive (one drag per pointer) and targetExclusive
// (one dragger per widget), a true 1:1, so two pointers can't both seize one widget.
```

`defineRelation` returns a `RelationType` with `__kind: 'relation'`, mirroring `defineComponent`/`defineTag`/`defineResource`. Name-collision detection is identical to the existing three (`world.ts:163`).

### World methods (each mirrors an existing primitive)

```ts
// mutation — mirror addComponent / removeComponent
world.relate(source, ChildOf, target, payload?)   // throws if source or target is not alive
world.unrelate(source, ChildOf, target?)           // target omitted → remove all of source's edges

// forward read
world.getTargets(source, ChildOf): EntityId[]      // [] if none
world.getTarget(source, ChildOf): EntityId | undefined   // convenience for sourceExclusive relations
world.related(source, ChildOf, target): boolean

// inverse read — the denormalized-inverse killer
world.getSources(ChildOf, target): EntityId[]      // always available — backed by the intrinsic reverse index

// edge payload
world.getPayload(source, ChildOf, target): P | undefined
world.setPayload(source, ChildOf, target, Partial<P>)   // shallow-merge, mirrors setComponent

// per-tick batches — mirror queryAdded / queryRemoved, cleared by clearDirty()
world.queryRelation(ChildOf): [EntityId, EntityId][]          // all live edges (mirror queryTagged)
world.queryRelationAdded(ChildOf): [EntityId, EntityId][]
world.queryRelationRemoved(ChildOf): [EntityId, EntityId][]   // INCLUDES destroy-driven removals (Option A, per RFC-001 §queryRemoved)

// synchronous observers — mirror onComponentChanged / onComponentRemoved
world.onRelationAdded(ChildOf, (source, target, payload) => void, sourceId?): Unsubscribe
world.onRelationRemoved(ChildOf, (source, target, prevPayload) => void): Unsubscribe   // fires BEFORE teardown

// introspection — mirror getComponentsOf, for devtools edge-rendering
world.getRelationsOf(entity): { relation: RelationType; dir: 'out' | 'in'; other: EntityId }[]
```

### Semantics

**Source destroyed.** Symmetric to component teardown: the source's outgoing edges simply vanish. `onRelationRemoved` fires for each, `queryRelationRemoved` includes them. No policy needed — the source is gone.

**Target destroyed → `onTargetDestroy` policy fires for every source pointing at it.** This is the part only the framework can guarantee (it runs inside `destroyEntity`):

| Policy | Effect on each source | Maps to today's hand-rolled |
|---|---|---|
| `'cascade'` | the source is destroyed too | selection chrome reaped with its target |
| `'clear'` *(default)* | drop the edge; source lives on | `ParentFrame` removed → child returns to root |
| `{ tag: Cancelled }` | add the `Cancelled` tag to the source | `recognizerIntegrity` cancelling on `Capture` loss |
| `'keep'` | **edge survives, now dangling** — target path skipped entirely (spec below) | `Follower` retaining the last target id while the cursor shrinks out |
| `(ctx, src, tgt) => Effect[]` | **escape hatch** — return *deferred* effects | the `Watches` nuance below |

**Cleanup runs inside `destroyEntity`, so policies are deferred — never reentrant.** `destroyEntity` removes the entity from `alive` *before* it tears down stores (`world.ts:288`), so a policy that mutated the world mid-teardown would see a half-destroyed entity and could recurse unpredictably. The built-in policies and the custom hook therefore **mutate nothing during the sweep** — they receive a **read-only context** and yield effects the framework applies *after* every relation store is swept:

```ts
type Effect =
  | { kind: 'destroy'; entity: EntityId }                                   // 'cascade'
  | { kind: 'tag'; entity: EntityId; tag: TagType }                         // { tag }
  | { kind: 'unrelate'; source: EntityId; relation: RelationType; target: EntityId };

// the read-only facade handed to a custom policy — queries only, no mutators (mutation is the return value)
interface PolicyContext {
  entityExists(e: EntityId): boolean;
  hasTag(e: EntityId, t: TagType): boolean;
  hasComponent(e: EntityId, t: ComponentType): boolean;
  getComponent<T>(e: EntityId, t: ComponentType<T>): T | undefined;
  getTargets(e: EntityId, r: RelationType): EntityId[];
  getSources(r: RelationType, e: EntityId): EntityId[];
}
type TargetPolicy<P> = 'cascade' | 'clear' | 'keep' | { tag: TagType }
  | ((ctx: PolicyContext, src: EntityId, tgt: EntityId, payload: P | undefined) => Effect[]);
```

A relation type is a global value (defined once, potentially shared across worlds), so the custom policy **cannot close over a world** — finding #2 from review. The `ctx` argument is how it reads the *destroying* world; it stays read-only so the "deferred effects only" rule holds. The `{ tag: TagType }` form is likewise a typed reference, **not** a `'tag:Cancelled'` string — it preserves `TagType` identity and the name-collision guard.

**`'keep'` is the one policy that touches nothing — specified exactly.** A `'keep'` relation's target-destroy path is *skipped*: the edge is **not** removed, **not** added to the `removed` buffer, and **no** `onRelationRemoved` fires. The edge becomes **dangling** — its target now satisfies `entityExists() === false`. Concretely:

| Read path | A dangling `'keep'` edge… |
|---|---|
| `getTargets(src, R)` / `queryRelation(R)` | **appears** — the edge still exists; the caller is expected to `entityExists`-check (exactly the `Follower` pattern today) |
| `getSources(R, deadTarget)` | returns `src` until `src` itself is destroyed |
| `queryRelationRemoved(R)` | **absent** — nothing was removed |
| `world.snapshot()` | **dropped** — an edge with a non-alive endpoint can't round-trip; in practice `'keep'` relations are presentation-only and `serialize: false` anyway |
| eventual cleanup | the dangling edge is removed when **`src`** is destroyed (the source-teardown path cleans both indexes) |

If "a policy that does nothing structural" feels off, the alternative is to **not** use `'keep'`: model it as `'clear'` + a system reacting to `queryRelationRemoved(R)` (the cursor starts its shrink on the removal signal and self-reaps). We keep `'keep'` because retaining the last-known target id is genuinely useful (e.g. "user *Ava* left" still needs Ava's id during the fade), but we flag both paths for the maintainer.

**The escape hatch is required, not optional.** Our integrity logic carries domain nuance no enum captures: a `Pending` recognizer is *allowed* to outlive its watched **pointer** (a multi-tap awaiting the next finger) but **not** its `Capture` **target** (`gesture.ts:238-242`). So `Watches` wants a custom policy — `(ctx, src) => ctx.hasTag(src, Pending) ? [] : [{ kind: 'tag', entity: src, tag: Cancelled }]` — while `Capture` wants the plain `{ tag: Cancelled }`. The win is not that the framework deletes our integrity system — it's that the system reads `queryRelationRemoved(Watches)` (an indexed signal) instead of **scanning every recognizer every tick** (`gesture.ts:113,145`).

**Cardinality is two independent bounds, enforced on `relate`.** `sourceExclusive` caps targets-per-source; `targetExclusive` caps sources-per-target. `ChildOf` is `sourceExclusive` only (one parent, many children); an ownership edge like `Dragging(pointer → widget)` sets *both* (a true 1:1). Relating past a bound replaces the displaced edge rather than adding a second (see Q3).

**Index-based, never archetype-keyed.** Relations must be a side index, not part of any archetype/query key. Two of our edges (`PointerTarget`, `PointerInside`) are *re-derived from geometry every tick*; if an edge change forced a structural/archetype migration it would thrash the per-frame `added`/`changed` buffers that our lazy systems depend on (the engine skips work on frames where declared reads didn't change). A `Map`-backed forward/inverse index has none of that cost. (This also keeps the implementation small — see below.)

## Implementation sketch (grounded in `world.ts`)

A `RelationStore` mirrors `ComponentStore` (`world.ts:16`):

```ts
interface RelationStore<P = unknown> {
  type: RelationType<P>;
  forward: Map<EntityId, Set<EntityId>>;   // source → targets  (sourceExclusive ⇒ Set size ≤ 1)
  inverse: Map<EntityId, Set<EntityId>>;   // target → sources  — ALWAYS maintained (target-destroy cleanup needs it)
  payload?: Map<string, P>;                // edge key `${src}\0${tgt}` → payload
  added: Set<string>;                      // edge keys added this tick
  removed: Set<string>;                    // edge keys removed this tick (incl. destroy)
  addedHandlers: Map<EntityId | '*', Set<RelationAddedHandler<P>>>;
  removedHandlers: Map<EntityId | '*', Set<RelationRemovedHandler<P>>>;
}
const relations = new Map<string, RelationStore>();   // peer of `components`, `tags`
```

**Destruction cleanup — a third loop appended to `destroyEntity` (after the tag loop at `world.ts:316`):**

```ts
const effects: Effect[] = [];              // collected during the sweep, applied strictly AFTER it
for (const store of relations.values()) {
  // (a) entity as SOURCE — outgoing edges always vanish (symmetric to component teardown)
  for (const tgt of store.forward.get(id) ?? []) {
    emitRelationRemoved(store, id, tgt);
    store.removed.add(edgeKey(id, tgt));
    store.inverse.get(tgt)?.delete(id);
  }
  store.forward.delete(id);
  // (b) entity as TARGET — SKIPPED for 'keep': the edge is intentionally left dangling,
  //     so we touch neither index nor the removed buffer (the source reaps it later).
  if (store.type.onTargetDestroy === 'keep') continue;
  for (const src of store.inverse.get(id) ?? []) {
    emitRelationRemoved(store, src, id);
    store.removed.add(edgeKey(src, id));
    store.forward.get(src)?.delete(id);
    effects.push(...resolveTargetPolicy(store.type, ctx, src, id));   // PURE — ctx is read-only, returns Effect[]
  }
  store.inverse.delete(id);
}
applyEffects(effects);   // only now is mutation safe: destroy (recurses safely; monotonic ids) · tag · unrelate
```

This reuses two facts RFC-001 already established: ids are **monotonic and never reused** (`world.ts:57,277`), so a stale source/target id stays `entityExists() === false` forever — no generational ids needed; and destroy-driven removals populate per-tick `removed` buffers under "Option A" semantics, exactly as `queryRemoved` does.

**`clearDirty` extension (`world.ts:637`):**

```ts
for (const store of relations.values()) { store.added.clear(); store.removed.clear(); }
```

That single line is the change-buffer participation that lets a system declare a relation as a per-tick `read` — and the reason this can't be a user-land layer.

`relate` / `unrelate` mirror `addComponent` / `removeComponent`: maintain both indexes, populate `added`/`removed` with net-cancellation (an `unrelate` then `relate` of the same edge in one tick cancels, per RFC-001's rule), and fire the synchronous observer. `relate` throws on a dead source or target (consistent with `addComponent`, `world.ts:326`).

## Non-goals (Request 1) — this is deliberately **not** Flecs

We are asking for a small indexed edge primitive, not a relationship engine. Explicitly out of scope, so review can confirm:

1. **Pair-as-archetype-key / type queries** (`(Relation, Target)` in the entity's type, `query(ChildOf, *)` matching). This is the heavyweight Flecs model; it's what would thrash our per-tick buffers. Side index only.
2. **Wildcards, transitivity, reflexivity, exclusive *traversal*** (`ChildOf` transitive closure, `up`/`cascade` query traversal). If we need ancestor walks we'll build them in user-land on `getTargets` (we already have `isFrameAncestorOf`).
3. **N-ary / typed multiple targets per relation kind beyond the source→target pair.** `Watches` is 1:N of the *same* relation; that's covered. Arbitrary hyperedges are not.
4. **Relation components carrying their own query-joinable data archetypes.** Payload is a plain per-edge value bag, read by id — not a queryable column.
5. **Modelling derived/per-tick refs as relations.** `PointerTarget`/`PointerInside` stay plain components; nobody asks for their inverse and they churn every frame. (Litmus we'll apply on our side: *make it a relation only if you query the inverse.*)

The opinion footprint does grow by one concept. We think it's justified by the shared thesis — unlike bundles/FSM (correctly pushed to user-land in RFC-001 because user-land *can* build them), a lifecycle-cleaned, inverse-indexed edge is something user-land *cannot* build correctly. If the maintainer disagrees on cost, the minimal viable subset is: `defineRelation` + `relate`/`unrelate` + `getTargets`/`getSources` + `onTargetDestroy` cleanup + `queryRelationRemoved`. Everything else (payload, observers, introspection) can follow.

---

# Request 2 — World snapshot &amp; restore

## Motivation

infinite-canvas serializes and reloads documents. Today that lives entirely in the consumer (`packages/infinite-canvas/src/ecs/serialization.ts`), and it is forced into an avoidable, bug-prone shape **by one missing capability: id-preserving restore.**

### What user-land can and cannot do today

A consumer *can* walk the world and produce a snapshot, using the RFC-000-era introspection API: `getAllEntities()`, `getComponentsOf(e)` + `getComponent(e, t)`, `getTagsOf(e)`, `getRegisteredResources()` + `getResource(t)`. So **serialize is buildable in user-land** (we built it).

A consumer *cannot* restore faithfully. `createEntity()` always returns a fresh monotonic id (`world.ts:277`); there is no `createEntityWithId`, no way to set `nextEntityId`. So on load **every entity is renumbered**, which forces the consumer to **remap every entity-typed field by hand** — which is exactly the pass at `serialization.ts:157-187`, remapping `ParentFrame`, `Children`, and `ContainerChildren` one field at a time. Every new entity-referencing field is one more thing to remember to remap, or one more load-time dangling-ref bug.

The root cause is structural: the authoritative state is closed over inside `createWorld` (`components`, `tags`, `resources`, `alive`, `nextEntityId`). Only the framework can reinstate an entity *with its original id* and restore the id counter so subsequent `createEntity()` calls don't collide.

## Proposed API

```ts
// produce a plain, JSON-able representation of the world (serialize-enabled types only)
world.snapshot(): WorldSnapshot

// reconstruct. Two entry points; the shared `emit` option (observers + dirty buffers) has opposite defaults:
restoreWorld(snapshot, registry, opts?: { emit?: boolean }): World                    // FRESH world, ids identical · emit defaults FALSE
world.import(snapshot, registry, opts?: { emit?: boolean }): Map<EntityId, EntityId>  // POPULATED world, remaps · emit defaults TRUE
```

```ts
interface WorldSnapshot {
  version: number;
  nextEntityId: number;          // restored so new entities never collide with loaded ones
  currentTick: number;
  entities: EntityId[];
  // each record holds ONLY serialize-enabled types (see policy below); a type with serialize:false is absent
  components: Record<string /*name*/, Record<EntityId, unknown /*data*/>>;
  tags:       Record<string /*name*/, EntityId[]>;
  relations:  Record<string /*name*/, Array<[EntityId, EntityId, unknown? /*payload*/]>>;  // see interlock
  resources:  Record<string /*name*/, unknown>;
}
```

`registry` is the consumer's set of `define*` results, matched by name (types are consumer-owned identity objects; the snapshot stores by name, and restore needs the type object to recreate each store with its collision anchor, `world.ts:171`).

**Cloning is `structuredClone`, not the existing helper.** An earlier draft claimed `snapshot()` could deep-clone "exactly as `instantiateDefaults` already does" — that was wrong: `instantiateDefaults` only shallow-copies the *top* level (`world.ts:43-51`), so nested objects still alias. The snapshot must `structuredClone` each value (throwing clearly on a non-cloneable one) or defer to a registered codec — it cannot lean on the existing helper.

### Per-type serialization policy (required — not all state is data)

A blanket "serialize every component, tag, relation, resource" would persist runtime-only state and choke on non-cloneable values. infinite-canvas has both: resources hold **class instances** (e.g. the spatial index), and document serialization deliberately **skips transient ECS state** (hover, recognizers, selection chrome). So each type must opt out or supply a codec — carried on the `define*` options (and overridable per snapshot call via the registry):

```ts
type Codec<T> = { write(value: T): unknown; read(raw: unknown): T };
type SerializePolicy<T> = boolean | Codec<T>;   // false = skip · true / absent = structuredClone · Codec = custom

// the `serialize` option is additive on every define* — note tags are presence-only, so boolean (no codec):
defineComponent<T>(name, defaults, opts?: { serialize?: SerializePolicy<T> }): ComponentType<T>
defineResource<T>(name, defaults, opts?: { serialize?: SerializePolicy<T> }): ResourceType<T>
defineRelation<P>(name, opts: { /* …relation opts… */ serialize?: SerializePolicy<P> }): RelationType<P>  // codec is for the PAYLOAD; the [src,tgt] pair is always structural
defineTag(name, opts?: { serialize?: boolean }): TagType   // boolean only — a tag has no data to encode

// `registry` carries the types restore needs (to rebuild stores with their collision anchors) + optional per-call overrides:
interface Registry {
  components?: ComponentType[]; tags?: TagType[]; relations?: RelationType[]; resources?: ResourceType[];
  serializeOverride?: Map<ComponentType | TagType | RelationType | ResourceType, SerializePolicy<unknown>>;
}
```

`snapshot()` omits `serialize: false` types entirely; for the rest it uses the codec if present, else `structuredClone`. The per-type default travels on the `define*` option (declared once); the `registry.serializeOverride` lets a single call force a different policy (e.g. a debug full-snapshot). This subsumes the relation `serialize` flag — one mechanism across all four kinds. Without it, snapshot cannot *replace* infinite-canvas's serializer, which is exactly a curated subset of world state — so this is a hard requirement, not a nicety.

### Restore vs import — the `emit` switch &amp; the external-index contract

Both entry points share one option, `emit`, with opposite defaults, because "load a document" and "merge a fragment" are different events. `emit` controls **two things together**: whether synchronous observers fire (`onEntityCreated` / `onComponentChanged` / `onRelationAdded` / …) **and** whether the per-tick `dirty` / `added` / `removed` buffers populate. It does **not** touch `currentTick` — restore sets that from the snapshot; import leaves the live tick alone.

- **`restoreWorld(…, { emit: false })` — the default — is silent.** Stores are populated directly: no observers, empty buffers. A load is not a frame of mutations; firing thousands of create events on document-open would wake every React subscriber and force a full re-index. After it returns, the world looks exactly as if built and then `clearDirty()`'d.
- **`world.import(…, { emit: true })` — the default — mutates normally** through the real `createEntity` / `addComponent` / `relate` paths, so observers fire and buffers populate. It returns the `old→new` id map and auto-remaps relation edges through it.

**External-index rebuild contract (review finding #3).** Consumers like infinite-canvas maintain *event-driven* external indexes off ECS writes — the spatial index, React subscriptions, the lifecycle recorder. A **silent** restore leaves those empty/stale, so the contract is explicit:

1. **Silent restore targets a *bare* world.** Restore *before* attaching observers/external indexes, then prime each index once from the restored state with a single `getAllEntities()` scan — the same priming it does on first boot. Recommended for document-open.
2. **To restore into a world that already has live indexes, pass `{ emit: true }`.** Every entity/component/tag/relation replays as a normal mutation, so indexes populate through their existing subscriptions. Costs a full event storm; correct when you can't re-prime from scratch.
3. A resource that *is* an external cache (e.g. the spatial index) may expose an optional `rebuild(world)` the consumer calls after a silent restore — but that hook lives in the consumer, not in this request.

### The one property that matters: **restore does not remap**

Because entity ids are just monotonic integers and the snapshot carries `nextEntityId`, `restoreWorld` reinstates **every id unchanged**. When ids are identical after load, **every entity reference and every relation edge is still valid as-is** — there is nothing to remap. That single property deletes `serialization.ts:157-187` outright.

Remapping is only `world.import`'s job — pasting a serialized subgraph into a world where those ids are already live (copy/paste, multiplayer merge). There the framework allocates fresh ids, returns the `old→new` map, and rewrites relation edges automatically.

## Non-goals (Request 2)

1. **A schema/migration system** for versioned snapshots. `version` is a number we pass through; migration is the consumer's concern.
2. **Partial/subgraph snapshot** (`snapshot(entitySet)`). Useful for copy/paste, but a follow-up; full-world first.
3. **Binary/compact encoding.** Plain JS objects (JSON-able); compaction is downstream.
4. **Persisting subscriptions, systems, or the scheduler.** Snapshot is *data only* — entities, components, tags, relations, resources. Systems are code.

---

## How the two requests interlock

One seam, and it cuts in our favour:

- **Relations need serialization** to round-trip (a `serialize: true` relation contributes its edges to `snapshot.relations`).
- **Serialization needs relations** to remap automatically. On **import** (remap mode), the framework owns relation edges, so it can rewrite every `[source, target]` through the `old→new` map with zero consumer code. It **cannot** do that for a plain `EntityId` stored in a component field — to the store that's an indistinguishable number.

So the combined recommendation, and the reason we filed both: **migrate entity references to relations, and id-preserving restore + auto-remapped relations together eliminate hand-written serialization glue.** Plain entity-typed component fields remain the consumer's remap burden — which is itself a further nudge to model real edges as relations. (If the maintainer prefers, an optional "this component field is entity-typed" hint on `defineComponent` could let plain refs remap too — but we are *not* requesting that here; relations cover our cases.)

---

## Migration, compatibility &amp; sequencing

- **Both additive.** New `World` methods + one new `defineRelation`. No existing signature changes. New internal stores; `destroyEntity` and `clearDirty` gain loops over an (initially empty) `relations` map — zero cost when no relation is defined.
- **Versioning.** Each is a minor (relations e.g. `0.5.0`, snapshot e.g. `0.6.0`), independently.
- **Prototype-first, as RFC-001 did.** We will prove the relation API shape against two acceptance tests before asking for a stable surface:
  1. **The playground prototype** (already on `0.4.0`, densest edge graph) — does it let us delete `recognizerIntegritySystem` and the `Watches`/`Capture` scans while preserving the `Pending` nuance via the escape hatch?
  2. **The production `ParentFrame` → `ContainerChildren` path** — does one `ChildOf` relation delete the materialised inverse + its apply/revert/load sync, *and* close the `parentFrameActive` removal gap via `queryRelationRemoved`?
  If a thin design can't do both, that's our signal the typed-`EntityId`-field status quo was right and we withdraw the relation ask.
- **What infinite-canvas deletes on adoption:** `ContainerChildren` denormalization + its sync; `serialization.ts:157-187` (the remap pass); `recognizerIntegrity`'s per-tick scans; ~12 scattered `entityExists` guards; the `Children` inverse component.

---

## Open questions

**Q1 — `relate` to a not-yet-alive target?** `addComponent` throws on a dead entity (`world.ts:326`). We propose `relate` throws on a dead source *or* target, so a born-dangling edge is impossible. Is there a real need to relate forward to an id you're about to create this tick? *Recommendation: throw; create the target first.*

**Q2 — Default `onTargetDestroy`.** `'clear'` (drop the edge, source lives) is the safe, least-surprising default and matches "a reference that points at nothing becomes no reference." *Recommendation: `'clear'`.*

**Q3 — Cardinality violation on `relate`: replace or throw?** For `sourceExclusive`, calling `relate(s, R, t2)` when `s` already points at `t1` (and symmetrically when `targetExclusive` and the target is already claimed). *Recommendation: replace the displaced edge (unrelate it, relate the new one), emitting removed-then-added — mirrors `setComponent` overwriting. A strict `relateStrict` that throws can follow if a consumer wants the guardrail.*

**Q4 — `restore` registry vs lazy types.** Restore needs the `RelationType`/`ComponentType`/etc. objects to recreate stores with their collision anchors. Pass an explicit `registry` array, or let stores be created lazily by name and bind the type object on first `define*`? *Recommendation: explicit registry — fail loud if a snapshot names a type the consumer hasn't defined, rather than silently holding orphan data.*

**Q5 — Snapshot determinism.** Should `snapshot()` guarantee stable key/entity ordering (sorted) for diff-friendly output? *Recommendation: yes — sort by name and id; cheap and makes snapshots diffable in tests and VCS.*

**Q6 — Ship order.** Relations and snapshot are independent, but relations without snapshot can't persist their edges, and snapshot without relations still pays the plain-ref remap tax. *Recommendation: relations first (it's the larger architectural lever and unblocks the v2 interaction work); snapshot second (it then auto-remaps relations and retires our serialization glue).*

**Q7 — Where does the serialization policy live?** On the `define*` options (travels with the type, one declaration) or only in the `registry` passed per call (per-snapshot control)? *Recommendation: both — a default on the type, overridable per call — so a transient type opts out once, yet a debug build can still take a full forced snapshot.*

**Q8 — Custom `onTargetDestroy` effect vocabulary.** The deferred-`Effect[]` set is `destroy` / `tag` / `unrelate`. Is that enough, or do real policies need `addComponent` / `setComponent` effects too? *Recommendation: start with the three; widen only when a concrete policy needs more, to keep the apply step total and analyzable.*

---

## What success looks like

After both ship and infinite-canvas adopts them:

- No *managed relation edge* dangles past a `destroyEntity` (unless its policy is `keep`) — that invariant is the framework's, not 15 reader-site `entityExists` checks. Plain `EntityId` component fields stay opaque to the store and remain the consumer's job — one more reason to model real edges as relations.
- "Give me this container's children" is `getSources(ChildOf, container)` — one index, always coherent, no `ContainerChildren`, no apply/revert/load sync.
- The `parentFrameActive` removal gap is closed by `queryRelationRemoved(ChildOf)`; the dual-source-of-truth is gone.
- A document round-trips with `world.snapshot()` / `restoreWorld()` and **no remap pass** — references and relations survive because ids do.
- Copy/paste and merge use `world.import()`; relations remap automatically.
- The library gained exactly one new concept (relations) and one new capability (snapshot) — both on the side of the line user-land cannot build, consistent with RFC-001's minimalism test.
