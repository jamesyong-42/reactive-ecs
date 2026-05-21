# RFC-001: Component-Removed &amp; Tag-Change Observability — Symmetric Primitives

- **Status**: Implemented (2026-05-21, branch `feat/query-removed-symmetry`)
- **Author**: James Yong
- **Date**: 2026-05-21
- **Area**: World API · per-tick query primitives · synchronous observers · entity destruction semantics
- **Driver**: `@jamesyong42/infinite-canvas` ECS refactor — specifically the FSM-via-component-bundles pattern (RFC-011 against infinite-canvas) and the known `parentFrameActive` limitation documented in infinite-canvas's data-flow doc §03 ("`ParentFrame` removal is not handled here because `reactive-ecs`'s `onComponentChanged` doesn't emit on `removeComponent`")
- **Scope**: strictly additive — no existing API changes shape. One behaviour delta on `destroyEntity` (fires events it currently skips).

---

## Summary

The observability surface of `World` today is **asymmetric**. The library has per-tick batches and synchronous observers for *adding* and *changing* components, but no equivalents for *removing* components. Tags have synchronous observers but no per-tick batches at all. And `destroyEntity` silently skips the observers that would otherwise fire for the components and tags it tears down.

RFC-001 closes the gap with **four new primitives and two consistency fixes** on `destroyEntity`:

| New primitive | Mirror of |
|---|---|
| `queryRemoved(ComponentType): EntityId[]` | `queryAdded(ComponentType)` |
| `queryAddedTag(TagType): EntityId[]` | `queryAdded(ComponentType)` (tag side) |
| `queryRemovedTag(TagType): EntityId[]` | `queryAdded(ComponentType)` (tag-remove side) |
| `onComponentRemoved(ComponentType, handler, entityId?): Unsubscribe` | `onComponentChanged(ComponentType, …)` |

| Consistency fix on `destroyEntity` |
|---|
| Fires `onComponentRemoved` for each component the entity owned (currently no observer fires) |
| Fires `onTagRemoved` for each tag the entity owned (currently silently skipped despite the observer existing) |
| Populates the new `removed` buffers for each component/tag the entity owned (so destroyed entities appear in `queryRemoved` and `queryRemovedTag`) |

Nothing in this RFC introduces new concepts. Every addition is the mirror of an existing primitive; every fix removes an existing inconsistency.

---

## Motivation

### The observability table today

| Channel | Per-tick batch | Synchronous observer |
|---|---|---|
| Component added | `queryAdded(C)` ✓ | `onComponentChanged(C)` ✓ (fires with `prev=undefined`) |
| Component set | `queryChanged(C)` ✓ | `onComponentChanged(C)` ✓ |
| **Component removed** | **missing** | **missing** |
| Tag added | **missing** | `onTagAdded(T)` ✓ |
| Tag removed | **missing** | `onTagRemoved(T)` ✓ |
| Entity created | (derivable via `queryAdded`) | `onEntityCreated` ✓ |
| Entity destroyed | (derivable via `onEntityDestroyed` + accumulator) | `onEntityDestroyed` ✓ — fires *before* teardown |

Three real consequences of the gaps:

1. **A system cannot react to "this entity stopped having component C this tick" via the standard per-tick pattern.** The only escape today is to maintain an external accumulator subscribed via `onComponentChanged` — except that doesn't fire on remove either, so the accumulator can't be built. The consumer must instead listen to `onComponentChanged` (to know when the component appears) AND inspect every entity each tick to detect departures by absence. This is what infinite-canvas's `parentFrameActive` system documents as a real limitation.

2. **`destroyEntity` is silently inconsistent with `removeTag`.** `removeTag()` fires `onTagRemoved`; `destroyEntity` deletes the tag entry directly without firing it. A consumer subscribed to `onTagRemoved(T)` misses every destruction-driven removal — a real correctness bug today, not just a future feature gap.

3. **There is no synchronous component-removal observer at all.** Consumers managing external resources keyed by a component (GPU buffers, DOM nodes, network subscriptions) have *no* way to learn that the component went away in time to release the resource before garbage. The current workaround is `onEntityDestroyed` + an external accumulator of which entities had the component — but this misses the bare `removeComponent` case where the entity stays alive.

### The driver use case (informational)

The immediate driver is infinite-canvas's planned FSM-via-component-bundles pattern, where a state transition removes one bundle of components and adds another. Without `queryRemoved`, a system that wants to react to "this entity just left state X" cannot do so directly — it has to read the state field rather than query for the leaving-set, which violates the architectural principle that systems should be state-unaware.

That use case is mentioned for context but **the design here is FSM-agnostic.** Every primitive in this RFC reads as useful with all FSM context stripped away: "tell me what entities lost this component," "tell me what entities gained this tag." Any consumer of reactive-ecs with similar needs benefits identically.

---

## Design

### `queryRemoved(type: ComponentType): EntityId[]`

Returns the entity ids that lost `type` this tick. Cleared by `clearDirty()`.

**Semantics — what counts as "removed":**

- A `removeComponent(entity, type)` call adds `entity` to the buffer.
- A `destroyEntity(id)` call adds `id` to the buffer of every component type the entity owned at destruction time.
- An `addComponent(entity, type, …)` call **removes** `entity` from the buffer (net-cancellation symmetry — see below).

**Includes destroyed entities (Option A semantics).** This is the universal industry convention (Bevy `RemovedComponents`, Flecs `OnRemove`, Unity ECS via state components). The reasoning is *cleanup symmetry*: if destruction were a separate channel, every consumer managing external resources would need to subscribe to both `queryRemoved` and `onEntityDestroyed` and dedupe. Treating destruction as mass-removal lets each consumer care only about the component it manages.

Dangling-id safety is already guaranteed by the existing entity model: `nextEntityId` is monotonic and never reused (`world.ts:52`), so `world.entityExists(staleId)` reliably returns `false` forever after destruction. No generational-id machinery needed.

**The buffer holds entity ids only, not component data.** By the time a system reads `queryRemoved`, the data is gone — `removeComponent`/`destroyEntity` deleted it. If a consumer needs to read the data one last time before it's gone, the correct channel is the new `onComponentRemoved` synchronous observer, which fires *before* deletion with the `prev` value still available.

**Net-cancellation symmetry with `queryAdded`.** Today, `removeComponent` calls `store.added.delete(entity)`, so an `addComponent` then `removeComponent` in the same tick leaves the entity in neither `added` nor (for queryChanged) `dirty`. The mirror policy for `removed`: an `addComponent` after a `removeComponent` in the same tick deletes the entity from `removed`. Concretely:

```
add then remove (no prior state):
  added: {E}        →  added: {}     (existing behaviour)
  removed: n/a      →  removed: {E}  (new)

remove then add (entity had C before this tick):
  added: {}         →  added: {E}    (existing behaviour)
  removed: {} → {E} → {} (new — re-add cancels out)
```

The buffers reflect *net effect* at tick-end relative to tick-start, which is the natural semantics and consistent with how `added` already works.

### `queryAddedTag(type: TagType): EntityId[]`

Returns the entity ids that gained `type` this tick. Symmetric with `queryAdded(ComponentType)`.

- `addTag(entity, type)` adds `entity` to the buffer.
- `removeTag(entity, type)` removes `entity` from the buffer (net-cancellation).
- Cleared by `clearDirty()`.

Required because there is currently no per-tick batch for tag additions. The only way for a system to learn "this entity just got this tag" today is via the synchronous `onTagAdded` observer, which forces the consumer to either run logic in the event handler (against ECS scheduler model) or maintain its own per-tick accumulator (boilerplate).

### `queryRemovedTag(type: TagType): EntityId[]`

Symmetric with `queryRemoved(ComponentType)`. Same Option-A semantics — includes destroyed entities; same net-cancellation rule.

### `onComponentRemoved<T>(type, handler, entityId?): Unsubscribe`

Synchronous observer. Mirror of `onComponentChanged`. Handler signature:

```ts
type ComponentRemovedHandler<T> = (entityId: EntityId, prev: T) => void;
```

**Fires:**
- On `removeComponent(entity, type)` — *before* the data is deleted, with the soon-to-be-gone value as `prev`.
- During `destroyEntity(id)` — once per component the entity owned, with `prev` reading the value before teardown.

**Optional `entityId` filter** matches the shape of `onComponentChanged`: pass an id to subscribe to a single entity's removals; omit it for the wildcard.

**Ordering inside `destroyEntity`:**

The existing contract is that `destroyListeners` fire *before* components/tags are torn down (`world.ts:267`) so they can still read the entity's full data. The new `onComponentRemoved` observers fire *during* the per-store teardown loop, after `destroyListeners` but before each store's data is deleted — so they still see the component's `prev` value. Same for `onTagRemoved` on the tag side. The ordering becomes:

```
1. destroyListeners fire (entity still fully intact)
2. alive.delete(id)
3. remove from query caches
4. for each component store the entity has:
     - emit onComponentRemoved(entity, prev=store.data.get(id))
     - delete from store.data, store.dirty, store.added; add to store.removed
5. for each tag store the entity has:
     - emit onTagRemoved(entity)
     - delete from store.entities, store.addedHandlers, store.removedHandlers
     - add to store.removed
```

This preserves the existing "destroyListeners can read data" contract while extending it to the new per-component / per-tag observers.

### `destroyEntity` consistency fixes

Already implied by the new primitives' semantics, but worth stating as standalone observable changes:

1. **`onTagRemoved` now fires from `destroyEntity`** for every tag the entity owned. Today it does not. This is a behaviour change for existing consumers of `onTagRemoved` — they may receive events they didn't before. Likely safe (cleanup code is the canonical `onTagRemoved` use case and welcomes more events), but called out explicitly in the migration section.

2. **`onComponentRemoved` (new) fires from `destroyEntity`** for every component the entity owned. New observer; no existing-consumer impact.

3. **`queryRemoved` and `queryRemovedTag` (new) include destroyed entities.** No existing-consumer impact.

---

## Implementation sketch

### Storage additions

Existing in `world.ts`:

```ts
interface ComponentStore<T = unknown> {
  type: ComponentType<T>;
  data: Map<EntityId, T>;
  dirty: Set<EntityId>;
  added: Set<EntityId>;
  handlers: Map<EntityId | '*', Set<ComponentChangedHandler<T>>>;
}

interface TagStore {
  type: TagType;
  entities: Set<EntityId>;
  addedHandlers: Map<EntityId | '*', Set<TagChangedHandler>>;
  removedHandlers: Map<EntityId | '*', Set<TagChangedHandler>>;
}
```

After:

```ts
interface ComponentStore<T = unknown> {
  // ... existing fields ...
  removed: Set<EntityId>;                                                  // new
  removedHandlers: Map<EntityId | '*', Set<ComponentRemovedHandler<T>>>;  // new
}

interface TagStore {
  // ... existing fields ...
  added: Set<EntityId>;    // new — per-tick batch for queryAddedTag
  removed: Set<EntityId>;  // new — per-tick batch for queryRemovedTag
}
```

### Mutation paths

`addComponent`:
- Existing: `store.data.set(...); store.dirty.add; store.added.add; updateCachesForEntity; emitComponentChanged`.
- Add: `store.removed.delete(entity)` (net-cancellation).

`removeComponent`:
- Existing: `store.data.delete; store.dirty.delete; store.added.delete; updateCachesForEntity`.
- Add: `store.removed.add(entity)` and `emitComponentRemoved(store, entity, prev)` *before* `store.data.delete`. Read prev via `store.data.get(entity)` before the delete.

`addTag`:
- Existing: guards on `store.entities.has`; `store.entities.add; updateCachesForEntity; emitTagAdded`.
- Add: `store.removed.delete(entity)` and `store.added.add(entity)`.

`removeTag`:
- Existing: guards on `store.entities.has`; `store.entities.delete; updateCachesForEntity; emitTagRemoved`.
- Add: `store.added.delete(entity)` and `store.removed.add(entity)`.

`destroyEntity`:
- Current loop tears down silently. New loop fires events and populates `removed` buffers:

```ts
destroyEntity(id) {
  if (!alive.has(id)) return;
  for (const listener of destroyListeners) listener(id);  // (1) existing
  alive.delete(id);                                        // (2)
  removeCachesForEntity(id);                               // (3)

  for (const store of components.values()) {               // (4) was silent
    if (store.data.has(id)) {
      const prev = store.data.get(id);
      emitComponentRemoved(store, id, prev);               // NEW
      store.removed.add(id);                               // NEW
    }
    store.data.delete(id);
    store.dirty.delete(id);
    store.added.delete(id);
    store.handlers.delete(id);
    store.removedHandlers.delete(id);                      // NEW (per-entity sub cleanup)
  }
  for (const store of tags.values()) {                     // (5) was silent for events
    if (store.entities.has(id)) {
      emitTagRemoved(store, id);                           // NEW
      store.removed.add(id);                               // NEW
    }
    store.entities.delete(id);
    store.added.delete(id);                                // NEW (clear per-tick add buffer)
    store.addedHandlers.delete(id);
    store.removedHandlers.delete(id);
  }
}
```

### Query methods

```ts
queryRemoved(type: ComponentType): QueryResult {
  return [...getComponentStore(type).removed];
}
queryAddedTag(type: TagType): QueryResult {
  return [...getTagStore(type).added];
}
queryRemovedTag(type: TagType): QueryResult {
  return [...getTagStore(type).removed];
}
```

### `clearDirty` extension

```ts
clearDirty() {
  for (const store of components.values()) {
    store.dirty.clear();
    store.added.clear();
    store.removed.clear();   // NEW
  }
  for (const store of tags.values()) {
    store.added.clear();     // NEW
    store.removed.clear();   // NEW
  }
}
```

### `onComponentRemoved` subscription

```ts
onComponentRemoved<T>(
  type: ComponentType<T>,
  handler: ComponentRemovedHandler<T>,
  entityId?: EntityId,
): Unsubscribe {
  const store = getComponentStore(type);
  const key: EntityId | '*' = entityId ?? '*';
  let handlers = store.removedHandlers.get(key);
  if (!handlers) { handlers = new Set(); store.removedHandlers.set(key, handlers); }
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}
```

Plus a matching `emitComponentRemoved(store, entity, prev)` mirroring `emitComponentChanged`. Both per-entity and wildcard handlers fire.

### Type additions in `types.ts`

```ts
export type ComponentRemovedHandler<T = unknown> = (
  entityId: EntityId,
  prev: T,
) => void;
```

The `World` interface adds: `queryRemoved`, `queryAddedTag`, `queryRemovedTag`, `onComponentRemoved`.

---

## Migration &amp; compatibility

**Additive in all consumer-facing ways**, with one observable behaviour change:

- New methods on `World` — strictly additive; existing call sites unaffected.
- Storage layout change is internal (private `ComponentStore`/`TagStore` interfaces).
- **Behaviour change:** `onTagRemoved` handlers will receive events from `destroyEntity` that they previously did not. This is a *bug fix*, not a regression — the symmetric behaviour (`removeTag` firing it) is the original intent. Consumers that wanted to filter to "only explicit removeTag" can use `onEntityDestroyed` exclusion if needed, but no real-world consumer is expected to want this.
- No package version bump required for consumers — published as a minor version (e.g., `0.4.0`) since strictly additive features.

Recommended infinite-canvas adoption path:

1. Bump infinite-canvas's `reactive-ecs` dependency to the release containing this RFC.
2. Migrate `parentFrameActive` to use `queryRemoved(ParentFrame)` for the limitation it currently documents.
3. Build the FSM-via-bundles pattern on top in a separate RFC (infinite-canvas RFC-011).

---

## Tests

Per primitive, paired with an existing test pattern:

| Existing test pattern | New mirror test |
|---|---|
| `queryAdded` returns entity after addComponent | `queryRemoved` returns entity after removeComponent |
| `queryAdded` returns entity after addComponent, then doesn't on next tick (clearDirty) | same for `queryRemoved` |
| `queryAdded` returns empty after addComponent + removeComponent in same tick | `queryRemoved` returns empty after removeComponent + addComponent in same tick |
| `onComponentChanged` fires on addComponent | `onComponentRemoved` fires on removeComponent |
| (none) | `onComponentRemoved` fires once per component during destroyEntity |
| `onTagRemoved` fires on removeTag | `onTagRemoved` fires on destroyEntity *(behaviour-change test)* |
| (none) | `queryRemoved` includes destroyed entities |
| (none) | `queryRemovedTag` includes destroyed entities |
| (none) | `queryAddedTag` returns entity after addTag |
| (none) | `queryAddedTag` net-cancels with removeTag same tick |

Plus a fuzz / property test pass: for any sequence of add/remove operations on a single entity within a tick, the final `queryAdded`/`queryRemoved` sets are consistent with the entity's net presence/absence at tick-end.

---

## Non-goals

Explicitly **not** part of this RFC, surfaced so review can confirm:

1. **Generational entity ids.** Not needed — `nextEntityId` is monotonic, never reused; `entityExists` is reliable forever after destruction. If the storage model ever changes to recycle ids, generational ids become a prerequisite — at that point a separate RFC adds them. Not now.

2. **`queryDestroyed(): EntityId[]` — per-tick batch of all destroyed entities.** Could be added as a peer to `queryAdded`/`queryRemoved`. Skipped here because `onEntityDestroyed` already exists synchronously and consumers needing a batch can accumulate it. Revisit if real demand surfaces.

3. **Batching / atomic-swap API** (e.g., `world.batch(entity, ops)` or `world.swapBundle(entity, remove[], add[])`). Tempting for use cases that swap many components atomically (FSM bundle swaps), but skipped here because:
   - The current per-mutation event firing has no observer-consistency problem in practice for the typical "unrelated components in a bundle" pattern.
   - It introduces a new API shape that wants its own design pass.
   - Bundle-swap convenience belongs in the consumer (a user-land utility), not in the lib.

   Revisit when a real observer-consistency problem surfaces or a benchmark proves the per-mutation overhead matters.

4. **FSM machinery.** The lib remains opinion-free about state machines. No `FsmState`, no `transitionTo`, no `Bundle`. Consumers build FSM utilities in user-land on top of the primitives this RFC provides.

5. **`onComponentAdded` as a distinct observer from `onComponentChanged`.** Today, `addComponent` fires `onComponentChanged` with `prev=undefined`. Splitting into a dedicated `onComponentAdded` event would be cleaner but is a separate concern (and a breaking change). Not in scope.

6. **Changing query semantics around destroyed entities for `queryAdded` / `queryChanged`.** They continue to *exclude* destroyed entities (the existing `store.added.delete(id)` / `store.dirty.delete(id)` calls in `destroyEntity` stay). Only the new `removed` buffers *include* destroyed entities. The asymmetry is deliberate: a destroyed entity has nothing to do next tick for `added`/`changed` consumers, but it has cleanup to do for `removed` consumers.

---

## Open questions

### Q1 — `onComponentRemoved` handler signature: `prev` non-optional?

`onComponentChanged`'s signature is `(entityId, prev, next)` with `prev: T | undefined` (undefined on add). For `onComponentRemoved`, `prev` is always defined (the value being removed). Should the type reflect that, with `prev: T` (non-optional)?

**Recommendation:** yes — `prev: T`. The observer only fires when the component exists; signature should reflect that. Slight asymmetry with `onComponentChanged` but type-honest.

### Q2 — Order of operations inside `destroyEntity`'s teardown loop

Current proposal (see implementation sketch step 4): fire `onComponentRemoved` *before* `store.data.delete`, so handlers can still read `prev`. Alternative: fire after, with `prev` read into a local before the delete. Either works; the question is whether observer handlers should be allowed to call back into the world during their notification.

**Recommendation:** stick with fire-before-delete, prev read at the call site. Handlers can read the entity but not the component being torn down (it's mid-removal). Matches Flecs' OnRemove semantics.

### Q3 — Wildcard handler ordering with per-entity handlers

`emitComponentChanged` fires per-entity handlers first, then wildcard. New `emitComponentRemoved` and `emitTagRemoved`-during-destroy should follow the same convention. Worth a one-line spec.

**Recommendation:** match `emitComponentChanged` ordering — per-entity first, then wildcard.

### Q4 — Should this ship as 0.4.0 (minor) or 0.3.x (patch)?

Strictly additive features → minor. The `onTagRemoved` behaviour change on destroy is technically observable to existing consumers but is a bug-fix and unlikely to break real code.

**Recommendation:** ship as 0.4.0. Release notes call out the `onTagRemoved`-on-destroy behaviour change explicitly under a "Fixes" section.

### Q5 — Implementation phasing

The four primitives + two fixes could ship as one PR or three (queryRemoved + onComponentRemoved together; queryAddedTag + queryRemovedTag together; destroyEntity fixes together). My intuition: **one PR**. They're conceptually one change — completing the observability table. Splitting risks half-shipping the symmetry and confusing consumers.

---

## What success looks like

After this RFC ships:

- The observability table in §Motivation has zero gaps.
- `destroyEntity` is consistent with `removeComponent`/`removeTag` — observers fire from both paths.
- Infinite-canvas can build the FSM-via-component-bundles pattern entirely in user-land with no further lib changes.
- Infinite-canvas's `parentFrameActive` limitation can be fixed with a one-line change to use `queryRemoved(ParentFrame)`.
- The library's opinion footprint hasn't grown. No new concepts are added; only existing ones are completed.
