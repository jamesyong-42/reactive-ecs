# RFC-005: The Transactional Kernel — Batches, Commit Diffs, and the Four-Layer Boundary

- **Status**: Proposed (the 1.0 architecture decision)
- **Author**: James Yong (drafted with Claude)
- **Date**: 2026-06-11
- **Area**: Kernel contract · change delivery · layer boundaries
- **Drivers**: `@jamesyong42/infinite-canvas` (undo + sync, both unbuilt — the cheapest moment to change the contract); the hazard inventory of mutation-time delivery; kernel surface ~45 members and growing.
- **Supersedes**: RFC-003 (origin becomes a batch attribute) and RFC-004 (the cursor becomes diff-folding). Both concepts survive; both mechanisms are subsumed.
- **Depends on**: v0.13 write semantics, ownership rule, partition rule — all retained.
- **Verdict in one line**: capture stays synchronous, delivery moves to commit — the batch becomes the unit of change, the kernel deletes its concept of time, and ~22 public members collapse into `batch()` + `onCommit(diff)`.

---

## The insight

Every consumer of change — UI bindings, derived-state systems, undo, sync, cleanup, devtools — needs to be told *what happened*, with prev/next values and attribution, *after a coherent unit of change*. **No consumer needs to be notified during a mutation.** The dying value and the origin must be *captured* at mutation time (they don't survive the moment), but they can be *delivered* whenever — as data in a payload.

> **Capture must be synchronous. Delivery doesn't have to be.**

v0.13 conflates them: observers fire inside the mutating call. Every hazard the library guards or documents — the `tearingDown` guard, the don't-mutate-mid-sweep doctrine, re-entrant handler cascades, subscribers observing half-assembled entities mid-setup — exists *only* because delivery is mutation-time. Move delivery to commit and the hazard class is not solved but **unrepresentable**.

Domain evidence is lopsided: tldraw (transactions → diffs, history scopes), Yjs (transactions with origins), Figma (batched property changes per action), Redux/Immer (action-grained patches), and even fine-grained signal systems (Solid `batch`, MobX actions) all converged on *fine-grained addressing, batched delivery*. Per-mutation observer dispatch as a public contract exists in game engines (Flecs, Bevy hooks) for archetype-bookkeeping reasons this library doesn't have — and Bevy pairs it with deferral machinery to make it survivable.

---

## The four layers

A thing belongs in the kernel only if (1) it must live inside the mutation path (capture), or (2) every consumer must agree on its semantics (storage, diff partition, query membership). Everything else moves up.

| Layer | Owns | Examples |
|---|---|---|
| **0 — Kernel (`World`)** | state, capture, coherent delivery, queries | writes, `batch`, `onCommit`, `query`, introspection, restore primitives |
| **1 — Time (scheduler)** | ticks, phases, ordering, tick-window folding | `SystemScheduler`, `PhasedScheduler`, `TickContext`, `foldDiffs` |
| **2 — Blessed consumers** | semantic-authority utilities on public API | `invertDiff`/`applyDiff`, identity index, devtools |
| **3 — App** | policy | undo stack & gesture grouping, sync protocol, serialization codec, UI bindings |

The kernel owns **no clock**: `currentTick`, `incrementTick`, `clearDirty`, `emitFrame`, `onFrame` all leave `World`. A tick is a scheduler concept — a fold of diffs between two drain points.

---

## Layer 0: the kernel contract

### Unchanged

All v0.13 state semantics: `createEntity` / `createEntityWithId` / `setNextEntityId` / `destroyEntity` / `entityExists`; `addComponent` (upsert) / `patchComponent` (strict) / `removeComponent` / `getComponent` / `hasComponent`; tags; relations (exclusivity, `onTargetDestroy` policies); resources; `query` / `disposeQuery`; introspection; the ownership rule and `freeze` (default `'auto'`: on when `NODE_ENV !== 'production'`). Never-reuse ids stay. The partition rule stays — its window shrinks from "the tick" to "the batch", which deletes the cross-tick `baseline` machinery.

### New: batches and commit delivery

```ts
batch<T>(fn: () => T, opts?: { origin?: string | symbol }): T;
onCommit(handler: (diff: CommitDiff) => void): Unsubscribe;
```

- **Auto-batch**: a bare mutation outside `batch()` is a batch of one — it commits (and delivers) when the call returns, including all internal cascades. Existing imperative code keeps working with per-call delivery granularity.
- **Nesting**: inner `batch()` calls merge into the outermost (one diff). An inner batch declaring a *different* explicit origin **throws** — one coherent diff cannot be honestly attributed to two origins. Same origin or no origin nests freely.
- **`batch` is a delivery unit, NOT an atomicity unit.** Mutations apply immediately — read-your-writes always holds, mid-batch reads see current state, queries stay coherent. An exception mid-batch leaves the applied mutations applied; the diff (of what was applied) is **delivered unconditionally**, then the exception propagates. No rollback is promised; that's why it's named `batch`, not `transact`. (App-level rollback = `applyDiff(invertDiff(partialDiff))` if ever needed.)
- **Origin** is unforgeable as in RFC-003: must be string or symbol; `undefined` remains the implicit "local user" attribution, readable only as `diff.origin`.

### `CommitDiff`

Net transitions over the batch window, by the v0.13 partition rule (absent→present = added; present→present with ≥1 write = changed; present→absent = removed; absent→absent = invisible). All values are zero-copy references to immutable snapshots.

```ts
interface CommitDiff {
  readonly seq: number;                              // monotonic per world
  readonly origin: string | symbol | undefined;

  readonly created: ReadonlySet<EntityId>;           // net created this batch
  readonly destroyed: ReadonlySet<EntityId>;         // net destroyed (alive at batch start)

  added<T>(type: ComponentType<T>): ReadonlyMap<EntityId, Readonly<T>>;                    // value = current
  changed<T>(type: ComponentType<T>): ReadonlyMap<EntityId, ChangedEntry<T>>;              // { prev, next }
  removed<T>(type: ComponentType<T>): ReadonlyMap<EntityId, Readonly<T>>;                  // value = dying prev

  addedTags(type: TagType): ReadonlySet<EntityId>;
  removedTags(type: TagType): ReadonlySet<EntityId>;
  relationsAdded(type: RelationType): readonly RelationEdge[];
  relationsRemoved(type: RelationType): readonly RelationEdge[];

  changedResources(): readonly ResourceType[];
  resource<T>(type: ResourceType<T>): ChangedEntry<T> | undefined;

  touched(entity: EntityId): boolean;                // O(1) routing test for per-entity adapters
  isEmpty(): boolean;
}
```

Notes:

- An entity created *and* destroyed within one batch is absent→absent: invisible everywhere. An entity created with components appears in `created` plus `added(type)` per component.
- **`destroyEntity` becomes atomic in the diff.** The destroyed entity, its removed components (with dying values), tags, edges, *and all `onTargetDestroy` cascade effects* land in one coherent diff. The six-step observable destroy sequence — v0.13's most carefully documented hazard surface — is no longer observable; consumers receive only the net result. The `tearingDown` guard is deleted because there is no handler running mid-sweep to guard.
- The dying-value contract (`onComponentRemoved` fires before deletion) is replaced by `removed(type)` carrying the value as data — same information, no timing obligation.

### Delivery semantics

1. The outermost batch exit computes the diff and delivers it to `onCommit` handlers in subscription order. The world is final and coherent during delivery; handlers may read freely.
2. **Delivery never nests.** Mutations made by a handler apply immediately (read-your-writes for the handler too), but their diff is **queued** and delivered FIFO after the current delivery completes. Handler cascades become a serial queue, not a re-entrant stack — this one sentence replaces the entire re-entrancy doctrine. (Dev mode may warn past a queue-depth threshold to surface feedback loops.)
3. Empty diffs are not delivered. Handler list is snapshotted per delivery; subscribes/unsubscribes during delivery take effect for the next diff.
4. Handler exceptions don't starve other consumers: all handlers receive the diff; the first exception (or an `AggregateError`) is rethrown after delivery completes.

### Deleted from `World` (~22 members)

- Seven per-mutation subscriptions: `onComponentChanged`, `onComponentRemoved`, `onTagAdded`, `onTagRemoved`, `onRelationAdded`, `onRelationRemoved`, `onResourceChanged` → `onCommit`.
- `onEntityCreated`, `onEntityDestroyed` → `diff.created` / `diff.destroyed`.
- Eight buffer queries: `queryChanged/Added/Removed`, `queryAddedTag/RemovedTag`, `queryRelationAdded/Removed`, `queryChangedResources` → diff fields (tick-folded at layer 1).
- All clock members: `currentTick`, `incrementTick`, `clearDirty`, `emitFrame`, `onFrame` → scheduler. (`tickWorld` moves with them.)
- `withOrigin`, `mutationOrigin` → `batch` option + `diff.origin`.
- The `tearingDown` guard and the per-store `baseline` maps — unrepresentable hazards need no guards.

Kernel surface lands at roughly 26 members, every one either storage, capture, delivery, or query.

---

## Layer 1: time

The schedulers keep registration, phases, topo-ordering, profiler. The execution contract changes:

```ts
interface TickContext {
  readonly tick: number;
  readonly diff: CommitDiff;   // live fold of every diff since the last tick boundary
}

defineSystem({
  name, phase?, after?, before?,
  runIf?: (world: World, ctx: TickContext) => boolean,
  execute: (world: World, ctx: TickContext) => void,
});

const loop = createTickLoop(world, scheduler);
loop.tick();            // run systems with ctx, advance tick, reset the fold window
loop.onTick(handler);   // end-of-frame hook (replaces onFrame)
```

- **`ctx.diff` is a live fold**: it includes diffs committed by earlier systems *this tick*, preserving the v0.13 writer→reader pipeline pattern (a `derive`-phase system sees what `simulate` wrote this tick). The fold resets at the tick boundary.
- **Diffs compose.** `foldDiffs(a, b)` is associative with the empty diff as identity — net-transition composition (added∘removed = nothing, added∘changed = added with the later value, removed∘added = changed, etc.). The same shape serves a batch, a tick, a gesture, or a send window; `foldDiffs` is exported as a pure utility because layer 3 needs it too (gesture undo = fold of a gesture's diffs).
- Multiple cadences stop being a problem by construction: every consumer folds its own window from `onCommit`. There is no shared buffer to starve.
- Future (separate RFC): declared `reads`/`writes` per system → inferred writers-before-readers ordering, with manual `after`/`before` as the escape hatch.

## Layer 2: blessed consumers

- **`invertDiff(diff): CommitDiff`** — pure data transform: added↔removed, prev↔next, created↔destroyed.
- **`applyDiff(world, diff, opts?)`** — replays a diff through the public write API inside a `batch`. Exact for component/tag/relation/resource changes on living entities. **Resurrection (applying a diff whose inverse destroys) requires identity**: never-reuse ids mean a destroyed id cannot return, so `applyDiff` accepts a remap hook, supplied by the identity index.
- **`createIdentityIndex(world, Identity)`** (RFC-006 candidate, unchanged from prior design): GUID component + guid↔id map maintained from diffs; provides `idOf`/`guidOf`/snapshot/restore and the `applyDiff` remap. App rule stands: *document-layer references use identity, not handles*.
- **Devtools** recorder/inspector ride `onCommit`; `seq` gives them total ordering.

## Layer 3: the app (recipes, not features)

Gesture undo, in full:

```ts
const UNDO = Symbol('undo');
let gesture: CommitDiff[] = [];
world.onCommit((d) => { if (d.origin === undefined) gesture.push(d); });

function endGesture() {
  if (gesture.length) undoStack.push(invertDiff(foldDiffs(...gesture)));
  gesture = [];
}
function undo() {
  const inverse = undoStack.pop();
  if (inverse) redoStack.push(invertDiff(inverse)),
    applyDiff(world, inverse, { origin: UNDO, remap: ids.remap });
}
```

Sync: send local-origin diffs per send window (`foldDiffs` over the window); apply remote batches via `applyDiff(world, remote, { origin: REMOTE })`; echo suppression is the origin check. The kernel never learns what a network, a file, or a history stack is.

---

## What is given up, stated plainly

1. **Sub-batch granularity.** Within one batch, intermediate writes coalesce (`changed.prev` is batch-start, `next` is batch-end). Auto-batches keep per-call granularity for bare mutations, so this only binds where the app *chose* to batch. An op-grained CRDT log inside a coarse batch is the one consumer this can't serve — the retained-log extension (diffs kept in a world-owned log) covers it if such a consumer ever materializes; gated until then.
2. **Mid-mutation reaction.** An observer can no longer correct a write before the writer's next line. No documented consumer does this; it's spooky-action and validate-on-commit is the principled replacement.
3. **A breaking release** larger than 0.13 — see migration. Pre-1.0, with both flagship consumers unbuilt, this price is at its lifetime minimum.

## Migration (0.13 → 0.14)

| v0.13 | v0.14 |
|---|---|
| `onComponentChanged(C, h, e?)` | `onCommit` + `diff.changed(C).get(e)` (framework adapters wrap this) |
| `onComponentRemoved` (dying value) | `diff.removed(C)` — value in the payload |
| `onEntityCreated` / `onEntityDestroyed` | `diff.created` / `diff.destroyed` |
| `queryChanged/Added/Removed(C)` in systems | `ctx.diff.changed/added/removed(C)` |
| `withOrigin(o, fn)` | `batch(fn, { origin: o })` |
| `mutationOrigin` in a handler | `diff.origin` |
| `tickWorld(world, fn)` | `loop.tick(fn)` |
| `emitFrame` / `onFrame` | `loop.onTick` |
| `clearDirty` / `incrementTick` / `currentTick` | gone — the scheduler owns time |
| don't-mutate-mid-destroy doctrine | gone — unrepresentable |

## Principles, updated

1. **Absence is never silent.** (unchanged)
2. **One ownership rule.** (unchanged)
3. **The batch is the unit of change.** Capture is synchronous; delivery is at commit; a diff is a coherent net-transition partition. *(replaces "events are the journal / buffers are the partition")*
4. **Entity first.** (unchanged)
5. **The kernel owns no clock.** Time lives in the scheduler; policy (history, wire, codec) lives in the app. *(replaces "the tick is one call", promoted one level up)*

## Adoption plan

1. **Spike first** (this gates everything): sketch `CommitDiff` + `batch` and port the two consumers that stress the contract from opposite ends — a `useComponent` React hook (finest routing) and the spatial-index system (tick folding). If both are clean, the rest is corollary.
2. Implement kernel `batch`/`onCommit`/diff; delete the 22 members; move clock to `createTickLoop`; update schedulers to `TickContext`.
3. Ship `foldDiffs` / `invertDiff` / `applyDiff` with property tests (fold associativity; `applyDiff(invertDiff(d))` restores pre-batch state for living entities; partition edge cases re-run per batch window).
4. Port devtools to `onCommit`.
5. RFC-006: identity index (now also the `applyDiff` remap provider). The reads/writes-inference scheduler RFC stays on the ledger.

## Test plan highlights

- Partition edge cases (re-add nets to changed, add-then-remove invisible, destroy folds) re-asserted per batch window.
- Fold algebra: associativity, identity, fold(batch diffs) ≡ diff of one merged batch.
- Delivery: queue FIFO under handler mutation; no nested delivery; snapshot subscription list; exception aggregation; unconditional delivery on mid-batch throw.
- Read-your-writes inside batches and inside handlers.
- Destroy atomicity: cascade chains produce one diff; no observable intermediate state.
