# RFC-006: Two-Channel Change Detection — Events to React, Delivered Changes to Record

- **Status**: Proposed (the 1.0 change-delivery decision)
- **Author**: James Yong (drafted with Claude)
- **Date**: 2026-06-16
- **Area**: Kernel contract · change delivery · undo/sync ground support · layer boundaries
- **Drivers**: `@jamesyong42/infinite-canvas` — undo/redo and multiplayer sync, both still unbuilt. The hazard inventory of mutation-time delivery. A change surface that grew eight per-tick buffer queries no consumer reads with values.
- **Supersedes**: RFC-004 (Change Cursors) and RFC-005 (Transactional Kernel). Both are withdrawn. The load-bearing insights of each are kept; the mechanisms are not. Absorbs the former RFC-006 "identity index" sketch, which dissolves (see §9).
- **Depends on**: RFC-003 (origin tagging, shipped — *retained in full, not superseded*); v0.13 write semantics, ownership rule, and partition rule, all retained.
- **Verdict in one line**: capture stays synchronous and the sync events stay; add one delivered form — a value-carrying change set, sealed per origin-run, delivered at the tick — and delete the eight buffer queries it subsumes. Net public surface 55 → 47 (−9 buffer queries subsumed, −2 frame-advance foot-guns internalized, +3 added). No clock eviction, no batch, no fold algebra, no kernel rewrite.

---

## The one insight worth keeping from RFC-005

> **Capture must be synchronous. Delivery doesn't have to be.**

The dying value and the writing origin do not survive the moment of mutation — they must be captured at write time. But every consumer that *records* change (undo, sync, derived state, devtools) wants the **net result of a coherent unit of work, with attribution**, delivered after the work is done. It does not need to be notified mid-mutation.

RFC-005 took that true insight and drew the wrong conclusion: that *all* delivery should move to a tick boundary, which meant deleting the synchronous events — and then rebuilding, in new machinery, everything those events gave for free. This RFC keeps the insight and rejects the conclusion. **Both kinds of delivery are legitimate, because they serve different consumers.** So the library carries two channels, and one crisp sentence tells you which to reach for:

> **Sync events are for *reacting* — invariants, GPU/DOM cleanup, fine-grained value subscriptions: things that need the moment.**
> **Delivered changes are for *recording* — undo, sync, derived state, devtools: things that need the net result with attribution.**

Everything below is the smallest set of additions that makes the second channel real, plus the deletions it strictly supersedes. Nothing that works today is removed to make room.

---

## Why RFC-004 and RFC-005 are withdrawn

Taking the author's own objection seriously — *"I don't like the design and direction since RFC-003; the ECS should stay simple, clear, rock solid"* — here is the honest diagnosis, not a dismissal.

**RFC-005 inverted the cost/evidence ratio.** RFC-003 added two members and ~15 lines to fix a structural impossibility (origin attribution cannot be reconstructed in user-land). RFC-005 proposed to rewrite the kernel contract, delete ~22 members, evict the clock to a new `createTickLoop`, and add a fold *monoid* with associativity laws as a tested obligation — for the **same two consumers, neither of which exists yet**. That is the exact failure mode that should make a library author uneasy.

**Most of RFC-005's machinery existed to compensate for RFC-005's own deletions.** It deleted the nine synchronous subscriptions, then needed a FIFO delivery-queue spec because all reaction was forced through one channel. It evicted `currentTick`/`incrementTick`/`emitFrame`, then needed `TickContext` and `createTickLoop` to put time back. It deleted the buffers, then needed `foldDiffs` to recompose windows. Subtract the self-inflicted wounds and little remains but the delivered-changes subscription (RFC-005's `onCommit`) — which this RFC keeps, renamed.

**`batch()` was a new concept with a misleading name** (a delivery unit, not an atomic one — a paragraph of disclaimers) duplicating a concept that already shipped. `withOrigin` already delimits exactly the runs that need their own attribution. We do not need a second scoping construct.

**RFC-004's `createChangeCursor` was a second capture path and a second partition classifier** — the precise critique it earned in its own "Alternatives" section, turned on itself. The one consumer that genuinely needed a consumer-owned window (off-cadence undo/sync) is served here by retaining change sets, which are themselves windows. RFC-004's *framing* survives intact and is promoted to the principle (§8): the events are a lossless capture layer; every coalesced view is a window over it. We keep the framing and drop the second mechanism.

The rule that falls out, and that governs this entire RFC: **add the missing delivered form; delete only what the delivered form strictly supersedes; touch nothing else.**

---

## What is kept, exactly

Everything in v0.13.1 except the eight buffer queries and `clearDirty` (§5). In particular, **all of these stay, unchanged**:

- The **ten synchronous subscriptions** with their `prev`-carrying signatures: `onComponentChanged`, `onComponentRemoved` (fires pre-teardown with the dying value), `onTagAdded`, `onTagRemoved`, `onRelationAdded`, `onRelationRemoved`, `onResourceChanged`, `onEntityCreated`, `onEntityDestroyed`, `onFrame`.
- **RFC-003 in full**: `withOrigin`, `mutationOrigin`, cascade origin inheritance. RFC-005 planned to delete these; that was wrong (§2, convergent prior art).
- The **clock**: `currentTick` (readable) and `tickWorld`. The clock is *not evicted* — it stays in the world, with `tickWorld` as its front door. But `incrementTick` and `emitFrame` move **off the public interface** (internal helpers `tickWorld` calls) — see §"Closing the frame-advance bypass". This is the opposite of RFC-005's clock eviction: time still lives in the world; it just stops having two public foot-guns that let a caller advance the frame without committing.
- All write semantics, the ownership rule, `freeze` (today a dev-only boolean — *not* `'auto'`; see §"The immutability contract is now load-bearing"), never-reused ids, `createEntityWithId` / `setNextEntityId`, relations and `onTargetDestroy` policies, the live `query` / `queryTagged` / `queryRelation` / `disposeQuery`, introspection.
- The **`destroyEntity` teardown sweep and its `tearingDown` mutation guard.** Because the sync channel stays, the mid-sweep doctrine stays with it — and it remains paid-for, shipped, tested. (This is the deliberate divergence from RFC-005, which made the guard "unrepresentable" only by deleting the channel it guards.)

---

## What is added (three members)

```ts
interface World {
  /**
   * The change detection for the current tick — net changes since the tick began,
   * the intra-frame reader for systems. Subsumes the eight buffer queries, adding
   * prev/next values. `changed(C).get(e).prev` here is the TICK-START value.
   *
   * Live WINDOW, stable ACCESSORS. The window accumulates as the tick progresses,
   * but each accessor CALL — `changes().added(C)`, `.changed(C)`, `.addedTag(T)`,
   * etc. — returns a stable snapshot materialized at call time (like a buffer query
   * returns a fresh array today). Iterating it is safe even if the loop body mutates
   * the world; to observe writes made after the call, call the accessor again.
   * Values are zero-copy refs; only the map/set container is freshly allocated.
   * The window itself is not retainable across a tick.
   */
  changes(): WorldChanges;

  /**
   * Subscribe to delivered change detection. The handler fires once per sealed
   * origin-run, in capture order, when the tick advances (§4) — once per tick in
   * the common single-origin case. The world is final and coherent during delivery;
   * handlers may read freely and may mutate (their writes apply immediately and are
   * delivered on the NEXT tick, never nested into this one). Delivery is serial and
   * exactly-once; every handler receives every change set even if an earlier handler
   * throws (errors are collected and rethrown as an AggregateError after the drain).
   */
  onChanges(handler: (changes: DeliveredChanges) => void): Unsubscribe;

  /**
   * The RelationTypes that have ever had a store created in this world — the
   * missing fourth member of the introspection group (Components/Tags/Resources
   * already exist). Closes the one core gap that makes a complete user-land
   * entity snapshot impossible today (§9).
   */
  getRegisteredRelations(): RelationType[];
}
```

That is the whole kernel addition: **+3 members, two small types** (`WorldChanges` and its delivered subtype `DeliveredChanges`, which adds one field). No `batch`, no public `commit`, no `TickContext`, no `createTickLoop`, no `foldDiffs`, no kernel apply utility, no identity index in core. The two readers — `changes()` to poll inside a system, `onChanges` to subscribe — both speak the same `added`/`changed`/`removed` vocabulary the buffer queries already used.

### The `WorldChanges` / `DeliveredChanges` types

The accessor verbs are deliberately the ones this library *already* uses for change detection — `added` / `changed` / `removed` / `addedTag` / `removedTag` / `addedRelation` / `removedRelation` / `changedResources` — the exact vocabulary of the `queryAdded` / `queryChanged` / `queryRemoved` buffer family this replaces. `world.changes().added(Position)` is the value-carrying successor to `world.queryAdded(Position)`; an ECS user recognizes the words. No `Diff`, no `Commit`, no `ChangeSet` in the surface.

```ts
type Origin = string | symbol | undefined;        // undefined = the implicit "local" origin (RFC-003)

interface Change<T> {
  readonly prev: Readonly<T>;   // value at window start (zero-copy snapshot ref)
  readonly next: Readonly<T>;   // value at window end   (zero-copy snapshot ref)
}

/**
 * The net change detection over a window, by the SHIPPED partition rule (v0.13):
 *   absent→present = added · present→present with ≥1 write = changed ·
 *   present→absent = removed · absent→absent = invisible.
 * added/changed/removed are disjoint by construction; every value is a zero-copy
 * reference to an immutable snapshot (the ownership rule is what makes this free).
 * Accessor calls mirror the old buffer queries one-for-one, now carrying values.
 *
 * NO `origin` here: this is the partition shape, and a window can span more than
 * one origin (a mixed-origin tick). Origin is a property of a delivered RUN, not
 * of a window — see `DeliveredChanges`.
 */
interface WorldChanges {
  readonly tick: number;

  readonly created:   ReadonlySet<EntityId>;    // net created in window
  readonly destroyed: ReadonlySet<EntityId>;    // net destroyed (alive at window start); their
                                                // dying components/tags/edges appear under removed*()

  added<T>(type: ComponentType<T>):   ReadonlyMap<EntityId, Readonly<T>>;  // value = current
  changed<T>(type: ComponentType<T>): ReadonlyMap<EntityId, Change<T>>;    // { prev, next }
  removed<T>(type: ComponentType<T>): ReadonlyMap<EntityId, Readonly<T>>;  // value = dying value

  addedTag(type: TagType):   ReadonlySet<EntityId>;
  removedTag(type: TagType): ReadonlySet<EntityId>;

  addedRelation(type: RelationType):   readonly RelationEdge[];            // per-edge netted (§7, repair 3)
  removedRelation(type: RelationType): readonly RelationEdge[];

  changedResources(): ReadonlyMap<ResourceType<unknown>, Change<unknown>>;

  isEmpty(): boolean;
}

/**
 * What `onChanges` delivers: a sealed, origin-homogeneous run. It IS a
 * `WorldChanges` (every accessor, plus everything the helpers need) and adds
 * exactly one field — the run's attribution. `origin` is well-defined here
 * BECAUSE the run is homogeneous; `undefined` means the implicit local origin,
 * never "mixed", because a mixed run cannot exist (origin change seals the run).
 */
interface DeliveredChanges extends WorldChanges {
  readonly origin: Origin;
}
```

Two shapes, one partition. `world.changes()` returns the **live, whole-tick** `WorldChanges` (a window — necessarily origin-blind, so it carries no `origin`; `prev` = tick-start). `world.onChanges` delivers a **sealed, per-origin-run** `DeliveredChanges` (`prev` = run-start, retainable, with the run's `origin`). The helpers (`invertChanges` / `applyChanges` / `mergeChanges`) take and return the base `WorldChanges` — none of them reads `origin` (you pass the origin to replay under as an `applyChanges` option) — so a `DeliveredChanges`, being a `WorldChanges`, flows through them unchanged. There is exactly **one** partition implementation (the shipped `classifyTransition`, now carrying values) — never a hand-rolled second definition of "changed."

> Why not one type with `origin: Origin | 'mixed'`? Because then every `origin` reader — the undo recorder, the sync outbox — would have to handle a `'mixed'` case that *can never occur on the value they receive* (deliveries are always homogeneous). The split keeps the delivered `origin` precise and pushes the "no single origin" fact to where it is true: the live aggregate, which simply doesn't have the field.

---

## The semantic addition (one rule)

> **A maximal run of consecutive same-origin mutations forms one delivered change set (`DeliveredChanges`). Sealed runs are delivered, in capture order, when the tick advances — the tick is the delivery point.**

Unpacking:

- **Effective origin** is `world.mutationOrigin` at the time of each mutation — exactly RFC-003's shipped semantics (innermost-wins nesting, cascade inheritance). `withOrigin` is unchanged.
- The world keeps **one open run**, which maintains its own first-touch baselines (per touched key, the value when *this run* first touched it = its `prev`). On each mutation, if the open run is non-empty and its origin differs from the effective origin, the run is **sealed** and a new one opens with fresh baselines. One comparison per mutation. Nested `withOrigin` therefore produces correctly-attributed sub-runs with no special rule and no throw — runs are just maximal same-origin stretches. RFC-005's batch-nesting-throw rule dissolves into nothing.
- **Sealing freezes the run's `next` values.** This is the load-bearing detail (and a genuine spec hazard if skipped): when a run seals, it materializes, for each key it touched, a zero-copy reference to that key's *current* snapshot — its `next`. It does **not** defer reading `next` until tick-end. Concretely, in `local₁ → remote → local₂` writing the same component C: `local₁` seals the instant `remote` begins, freezing C's `next` to its value *at that instant*; `remote` opens with C's value-now as its `prev`. Without seal-time freezing, `local₁`'s change set, read at tick-end, would wrongly absorb `remote`'s and `local₂`'s writes to C. Seal-time materialization is sound and cheap because the ownership rule makes every stored snapshot immutable: the reference frozen at seal stays valid forever even as the store's live pointer moves on. Cost is O(keys the run touched), zero-copy. (When a tick has a single origin — the common case — the one run's window coincides with the whole-tick window, and the two baselines are the same map.)
- Most frames produce exactly **one** change set with `origin: undefined` (the local user). A frame where a remote apply lands mid-tick produces e.g. `[local₁, remote, local₂]` — each origin-homogeneous, in capture order. Attribution and the net result are answered by separate, honest windows instead of one structure forced to do both.
- An entity created *and* destroyed inside one window is absent→absent: invisible everywhere. A `destroyEntity` and its whole `onTargetDestroy` cascade land in the call-site origin's run as **one net result** — the six-step observable teardown collapses to one change set on the *delivery* channel (devtools and undo see a clean atomic delete), while the *sync* channel still fires its per-step events for cleanup handlers that want the moment. Both truths coexist because both channels exist.

### Why no `batch()`, no public `commit()`/`flush()`

`withOrigin` already is the run delimiter; a remote apply is `withOrigin(REMOTE, () => applyOps(...))`, and that *is* the batch boundary, named honestly. And `tickWorld` already is the delivery boundary (principle 5 — the tick is one call). Adding `batch()` would duplicate the first; adding a public `commit()`/`flush()` would duplicate the second — there is no delivery boundary distinct from the tick, so there is one method. An app with no scheduler loop flushes by calling **`tickWorld(world)` with no function**: it seals, delivers, and advances the frame. That is the documented "just deliver" path, and it keeps principle 5 literally true.

---

## Delivery semantics, specified (the mandated repairs)

The adversarial review of the competing designs found that three of them shared one root failure: they declined or under-specified the delivery mechanism and built a journal on top of it anyway. This RFC specifies it precisely, and — importantly — specifies the two channels **differently**, because they have different consumers and different hazards.

### The sync channel (`on*`) — unchanged contract, one guard added

Synchronous events fire inside the mutating call, per-entity-handlers before wildcard, exactly as shipped. RFC-003's `mutationOrigin` reads correctly because emission is synchronous. **We deliberately do not impose a store-order delivery queue on this channel** — doing so would complicate the ambient-origin contract, and, critically, *the delivered change set does not depend on event-stream ordering* (it is computed from partition baselines, not by replaying events — see below), so the ordering hazard that sank the journal-style designs simply does not exist here.

The one addition is defensive: a **re-entrancy depth guard**. A handler that mutates may re-trigger handlers synchronously (it can today); past a configurable depth (default ~1000) the guard throws a loud cycle error instead of overflowing the stack. The existing `tearingDown` mid-sweep guard is unchanged.

### The delivery channel (`onChanges`) — serial, non-nesting, deliver-all

A delivered run (`DeliveredChanges`) is **the net partition of its run's window** (run-start baseline → seal-time value), computed from baselines, not accumulated by replaying the event stream. Two consequences matter. First, the change set is *immune to handler re-entrancy ordering*: it reports net `baseline → endpoint` state, which is order-independent (a nested handler that overwrites a key just moves the endpoint; it cannot scramble a prev/next pair the way replaying an event sequence would). Second — and this is the spec hazard called out above — *the endpoint is fixed at SEAL time, not at delivery time*: a run materializes its `next` refs when it seals, so a later run's writes to the same key never leak backward into an earlier run's already-sealed change set. By delivery time, every sealed change set is fully frozen; delivery only *hands them out*. From this follow clean rules:

1. **Boundary order is seal → reset → deliver.** `tickWorld` (a) runs the tick function, (b) seals the open run, (c) **resets** the run state and the `changes()` window to fresh, then (d) delivers the sealed runs to `onChanges` handlers. Because the window is reset *before* delivery, any mutation a handler makes accumulates into the fresh window and is delivered at the **next** commit — never lost, never double-counted, never mutating the change set being delivered. `changes()` during delivery reads the new window. (This fixes the boundary-truncation flaw that two competing designs shared.)
2. **Delivery is serial and never nests.** Handlers fire in subscription order; handler mutations apply immediately (read-your-writes holds for the handler too) but their changes queue for the next tick. The re-entrancy doctrine for *this* channel reduces to one sentence.
3. **Deliver-all-on-throw.** Every handler receives every sealed change set even if an earlier handler throws. The first exception (or an `AggregateError` if several) is rethrown after the drain. One buggy devtools or cleanup subscriber cannot silently truncate the change set that undo or sync depends on.
4. **No empty deliveries.** Empty runs are not delivered. The handler list is snapshotted per delivery; subscribes/unsubscribes during delivery take effect next tick.

`tickWorld` throws if called during delivery or mid-mutation (the constraints `clearDirty` had).

### Full `tickWorld` order

```
tickWorld(world, fn?):
  fn?.(world)              // systems run; each write updates baselines + the open run; sync events fire live
  seal open run            // freeze its next refs (see "Sealing freezes the run's next values")
  reset run state + changes() window
  errors = []
  deliver sealed runs → onChanges handlers   // serial, deliver-all; collect throws into errors, do NOT rethrow yet
  emitFrame()              // onFrame flush hook; collect throws into errors too
  incrementTick()          // the frame ALWAYS advances, even if handlers threw
  if errors.length: throw AggregateError(errors)
```

**The frame always advances.** Handler exceptions — from `onChanges` *or* `onFrame` — are collected, not propagated mid-sequence. `emitFrame()` and `incrementTick()` run unconditionally (a `finally`-style guarantee), and the `AggregateError` is thrown only after the clock has moved. This closes the wedge the naïve order would create: a single throwing `onChanges` handler must not be able to freeze the tick counter or strand the world between frames, where the next `tickWorld` would re-deliver or desync. `WorldChanges.tick` is the tick the window belonged to (pre-increment).

> Note on `onFrame`: under this RFC the buffers are gone, so `onFrame` no longer reads this-tick change data (it fires *after* the window reset and delivery). It is purely a frame-boundary flush signal — the moment a UI adapter pushes its batched, already-collected state. This-tick change data comes from `onChanges` or, inside a system, `changes()`.

---

## What is deleted (nine members)

```
queryAdded · queryChanged · queryRemoved
queryAddedTag · queryRemovedTag
queryRelationAdded · queryRelationRemoved
queryChangedResources
clearDirty
```

Their job — "the partition, polled, presence-only" — is **strictly subsumed**: `changes()` is the same window and the same partition, plus values; `onChanges` is the same partition, per origin-run, delivered. The documentation tax dies with them: the net-transition rule is stated **once**, on `WorldChanges`, instead of being re-explained in eight method docblocks. `clearDirty` is replaced by the seal→reset inside `tickWorld`.

The live queries (`query`, `queryTagged`, `queryRelation`, `disposeQuery`) are **not** buffers and are **not** touched.

Two more members leave the *public* interface without being deleted — `incrementTick` and `emitFrame` become internal helpers `tickWorld` calls (see next section). They are not removed from the world; they are removed from the surface a consumer can reach.

| | members |
|---|---|
| v0.13.1 public World surface | 55 |
| deleted (subsumed by `pending`/`onChanges`) | −9 |
| demoted to internal (`incrementTick`, `emitFrame`) | −2 |
| added (`pending`, `onChanges`, `getRegisteredRelations`) | +3 |
| **v0.14 public World surface** | **47** |

---

## Closing the frame-advance bypass

With `clearDirty` gone and `tickWorld` the sole commit point, leaving `incrementTick()` and `emitFrame()` on the public interface would be a foot-gun: a caller could advance the frame *without committing* — never sealing the open run, never delivering `onChanges`, desyncing `currentTick` from the run state. There is no longer any legitimate standalone use for them — their one documented purpose ("used by the engine after tick") is exactly what `tickWorld` now owns, and a grep of the codebase confirms nothing but `tickWorld` calls them in non-test code.

So they move **off the public `World` interface** and become internal steps of `tickWorld`. `currentTick` stays a public read (no bypass risk — it cannot advance the clock). An app driving its own loop calls `tickWorld(world, fn)`; an app with no scheduler flushes with `tickWorld(world)`. There is exactly one way to advance a frame, and it always delivers. (This mirrors the 0.13 "private scheduler flag" cleanup — same instinct, applied to the clock.)

---

## The immutability contract is now load-bearing

A `WorldChanges` holds **zero-copy references** to the snapshots that were live when each value was written — an undo stack may hold them across thousands of ticks. This is only sound if a stored value is *never mutated in place* after it is replaced. v0.13's ownership rule already says so ("plain data cloned in, replaced never mutated"), and `createWorld({ freeze })` enforces it with a dev-mode deep-freeze — but `freeze` today is an **opt-in boolean** (verified: `freeze?: boolean`, default off), and opt-in dev safety has a dismal activation rate.

This RFC *raises the stakes* of that contract — a single in-place mutation of a retained value silently corrupts undo history — but deliberately **does not bundle the fix**. Flipping the default to a `NODE_ENV`-gated `'auto'` (on in dev, off in prod) is a separate, self-contained decision that can ship on its own minor (it was an RFC-004 proposal; RFC-004 is withdrawn, so the proposal is now unowned and must be re-decided on its own merits). This RFC's only claim is the dependency: **if `onChanges` ships, the `'auto'` freeze default should ship no later**, because retained change sets make the integrity condition matter for correctness, not just hygiene. Tracked as Open Question 9.

---

## The line, consumer by consumer

| Consumer | Placement | Served by |
|---|---|---|
| **UI bindings** | core channels; React hooks **blessed** (`/react` subpath) | `useComponent(entity, type)` over the *kept* `onComponentChanged(C, h, entity)` — O(1) routed, koota's exact model; `useSyncExternalStore` + React batching coalesce the per-frame burst. Set-grain panels read `onChanges` and flush on `onFrame`. |
| **Derived state (spatial index)** | core primitive; the index is **app** | A derive-phase system reads `world.changes().changed(Position)` (and `.removed(Position)` for the dying value) — net since tick start, *with prev/next*, so it moves cells `cell(prev) → cell(next)` and drops the shadow-copy map `queryChanged` forced it to keep. |
| **Undo/redo** | **app**, on core ground support | Ground support = `DeliveredChanges` (lossless prev/next + origin) + the tombstone identity doctrine (§9) + never-reused ids. The stack, marks, coalescing, caps, and invert/apply (~100–150 lines) are app code — exactly the author's line, and unanimous prior art (tldraw, Figma, Yjs, Excalidraw all keep the stack in the editor). |
| **Sync (multiplayer)** | **app**, on core ground support | Outbox collects change sets whose `origin !== REMOTE`; codec (ids ↔ GUIDs) is app; remote batches apply under `withOrigin(REMOTE, …)`. Echo suppression is one origin filter. Core contributes attribution only. |
| **Cleanup (GPU/DOM)** | **core — already shipped** | `onComponentRemoved` / `onEntityDestroyed` fire synchronously pre-teardown with the dying value. This consumer is the proof that deleting the sync events was over-reach: a net change set *structurally cannot* serve a resource added and removed within the same window. |
| **Devtools** | **blessed** (exists) | The recorder gains an `onChanges` timeline (run-grain, ordered by delivery + `tick`) and keeps the sync events for op-grain traces. |

**Reframed away.** "Per-tick buffers" as a *consumer* — they were the spatial index wearing kernel residency; the spatial index now reads `changes()` and the buffers stop being a public concept. "Per-mutation synchronous reaction" as a *UI* need — it is a cleanup/invariant need only; UI wants batched end-state, which is the tick.

---

## Walkthrough: drag 3, delete 1, undo, undo, redo

All code is **app-level** except the two marked library calls. Library ground support: change sets, origins, never-reused ids.

```ts
const HISTORY = Symbol('history');
const REMOTE  = Symbol('remote');
const Tombstoned = defineTag('Tombstoned');   // document delete = tombstone (architecture narrative)
const DOC_TYPES = [Position, Size, Stroke /* … */];

type Entry = { label: string; changes: WorldChanges[] };
const undoStack: Entry[] = [], redoStack: Entry[] = [];
let gesture: WorldChanges[] = [];

world.onChanges((c) => {                                   // [library: onChanges]
  if (c.origin !== undefined) return;                    // skip REMOTE and HISTORY runs
  if (!touchesDocument(c, DOC_TYPES, Tombstoned)) return;// pointer/chrome entities never recorded
  gesture.push(c);                                       // zero-copy: the change set retains snapshot refs
});
function endGesture(label: string) {
  if (gesture.length) { undoStack.push({ label, changes: gesture }); redoStack.length = 0; }
  gesture = [];
}
```

**The drag.** Each frame the input system writes `patchComponent(eN, Position, …)` for e1, e2, e3 (origin `undefined`). Many pointermove writes per frame coalesce to net-per-frame by the partition rule; each `tickWorld` delivers one `DeliveredChanges` whose `changed(Position)` has three `{prev, next}` entries. A 60-frame drag → 60 small change sets in `gesture`, memory bounded by touched keys, not write count.

**The delete.** The delete command is `world.addTag(e2, Tombstoned)` — **not** `destroyEntity`. e2 keeps its id, components, and relation edges; renderers and the spatial index exclude it via `Not(Tombstoned)`. The change set records `addedTag(Tombstoned) = {e2}`. `destroyEntity` is reserved for interaction entities and for eviction past the undo horizon.

`pointerup` → `endGesture('Move 3')`; the delete → `endGesture('Delete')`. Stack: `[move, delete]`.

**Undo / undo / redo** (app code over the blessed `/changes` helpers of §10):

```ts
function undo() {
  const entry = undoStack.pop(); if (!entry) return;
  world.withOrigin(HISTORY, () => {                       // [library: withOrigin]
    for (let i = entry.changes.length - 1; i >= 0; i--)   // apply inverses in reverse order
      applyChanges(world, invertChanges(entry.changes[i]), { onMissing: 'skip' });
  });
  redoStack.push(entry);
}
function redo() {
  const entry = redoStack.pop(); if (!entry) return;
  world.withOrigin(HISTORY, () => {
    for (const c of entry.changes) applyChanges(world, c, { onMissing: 'skip' });
  });
  undoStack.push(entry);
}
```

- `undo()` #1 pops *delete* → `removeTag(e2, Tombstoned)` under `HISTORY`. e2 reappears in every `Not(Tombstoned)` query that instant; the next tick delivers the change to the index and UI. The recorder ignores the `HISTORY` run — **undo does not re-record** (same mechanism as sync echo suppression).
- `undo()` #2 pops *move* → applies 60 inverse change sets in reverse, writing each entry's `prev`. Applying the list in reverse is **why no fold monoid is needed** — squashing consecutive same-key entries is an optional ~15-line memory optimization (`mergeChanges`), not a correctness obligation.
- `redo()` re-applies *move* forward. No inverse logic was ever hand-written; inverses are mechanical because every entry carries `prev`.

**Identity across the delete — the id-reuse hazard.** There is none, structurally: the library never reuses ids, and the app never destroyed e2. Every journal entry referencing e2 stays valid through delete→undo→redo because e2's data never left the world. The classic "redo applies to a resurrected stranger" corruption requires id reuse or recreate-under-new-id; tombstoning makes both impossible *within the undo horizon*. **Eviction past the horizon** (entries falling off the stack): the app `destroyEntity`s tombstoned entities under a dedicated `ORIGIN_EVICT` (excluded from the sync outbox and the recorder; §7 repair 6), tombstoned subtrees evicted together. **GUIDs** enter only for the *wire and disk* boundary (§9), never for in-horizon undo.

---

## Walkthrough: intra-frame — writer → reader → UI → cleanup, one tick

```
tickWorld(world, scheduler.execute)
 ├─ simulate: SystemA → patchComponent(e, Position, …) × N
 │     • baselines + open run updated; first touch captures prev ref
 │     • onComponentChanged fires SYNC (kept) — invariants, useComponent dirty-marking
 ├─ derive: SpatialIndexSystem
 │     const c = world.changes();                        // this tick's net changes
 │     for (const [e, {prev, next}] of c.changed(Position)) grid.move(e, cell(prev) → cell(next))
 │     for (const [e, prev]         of c.removed(Position)) grid.delete(e, cell(prev))  // dying value, no shadow copies
 ├─ seal → reset → deliver:
 │     • UI adapter: collect touched (entity,type) keys → ONE batched React update
 │     • undo recorder: gesture.push(changes)
 │     • sync outbox: origin !== REMOTE → enqueue for the send window
 ├─ emitFrame()        // onFrame: UI adapter flushes here
 └─ incrementTick()
```

- The spatial index sees **everything earlier phases wrote this tick** because `changes()` is the live whole-tick window — the writer→reader pipeline is preserved without a `TickContext`. Scheduling it after writers is a documented obligation (it already is, via `after`).
- **Cleanup with the dying value:** `removeComponent(e, MeshHandle)` fires `onComponentRemoved(MeshHandle, (e, prev) => prev.dispose())` synchronously, before deletion — the shipped contract, untouched. Apps preferring frame-end disposal read `changes.removed(MeshHandle)` from `onChanges` instead. Both grains exist because the sync channel was kept.
- **Mixed-origin tick:** a `withOrigin(REMOTE, …)` apply between local writes delivers `[local₁, remote, local₂]` in capture order, while `changes()` stays origin-blind — so the index converges on world state regardless of who wrote it, and attribution stays available to the consumers that split on it.

---

## Walkthrough: echo suppression

```ts
socket.on('ops', (ops) => world.withOrigin(REMOTE, () => applyOps(world, ops))); // remote apply
world.onChanges((d) => { if (d.origin !== REMOTE) outbox.push(d); });             // outbox: no echo
// recorder (above): only origin === undefined is recorded → remote edits never enter local undo
```

A remote batch seals as one `REMOTE` run → the outbox filter drops it → no re-broadcast; its cascades inherit `REMOTE` (shipped) so a remote destroy's fan-out cannot leak into the local journal piecemeal. An undo replay seals as `HISTORY` → the recorder drops it (no re-record) but the outbox **sends** it (`HISTORY !== REMOTE`) — correct: your undo reaches collaborators as forward operations (the Figma model).

---

## Layer 2: the blessed `/changes` utilities

Pure functions on the change-set shape, in an optional subpath, **promoted only after the driver app has copied them verbatim** and proven the shape (the adoption gate, §11). Not in the kernel — they pass the admissibility test (user-land can write them on the public WorldChanges), but they are correctness-trap-shaped (inversion order, validate-before-apply), so one property-tested home is worth a blessed import.

```ts
invertChanges(d: WorldChanges): WorldChanges;
//  added↔removed, prev↔next, created↔destroyed. Involution. RELATION SEQUENCE IS REVERSED
//  (exclusivity displacement makes order load-bearing — §7 repair 3).

applyChanges(world: World, d: WorldChanges,
  opts?: { onMissing?: 'throw' | 'skip' }   // default 'throw' — absence is never silent
): { skipped: readonly unknown[] };
//  VALIDATE-FIRST then replay through the public write API: phase 0 checks all ids alive and
//  relation endpoints valid; only then does it mutate. Callers wrap in withOrigin themselves.
//  'skip' returns the skip report (used by undo under multiplayer: an op on an entity a peer
//  deleted no-ops at that key). NOT atomic — mitigated by validate-first + convergence.

mergeChanges(list: readonly WorldChanges[]): WorldChanges;
//  Optional memory optimization: coalesce a run of change sets to one. {prev: first.prev, next: last.next}
//  per key. Not a correctness dependency — reverse-order application already works without it.
```

No fold *monoid*, no associativity law as a tested obligation: because undo applies a list of change sets in reverse rather than pre-folding it, `mergeChanges` is a convenience, not a load-bearing algebra. That is the single largest simplification over RFC-005.

---

## Identity, snapshots, and the author's sketch

The author's sketch — *a GUID translation map plus `getEntitySnapshot(guid)` / `restoreEntitySnapshot(guid, state)`* — splits cleanly into a part that is right and a part that is misplaced.

**GUIDs survive at the world boundary only.** Multiplayer wire, save files, clipboard paste — anywhere an id must outlive the process or cross into another. Figma's `clientId:counter` minting is the precedent. GUIDs do **not** survive as the *undo* identity mechanism: inside the undo horizon, tombstone + never-reused ids make the translation map unnecessary, because an undo entry keyed by raw `EntityId` stays valid forever — the entity never died. A GUID map earns its keep precisely where ids genuinely cannot travel, and nowhere else.

**`getEntitySnapshot` / `restoreEntitySnapshot` are ~30-line *app* helpers** over shipped introspection + `createEntityWithId` — with **one real gap**, which is why this RFC adds the one introspection member it does: there is no `getRegisteredRelations()` today, and lazily-registered types are otherwise unenumerable, so a *complete* user-land snapshot is currently impossible. That gap is a two-line core fix (the missing fourth member of a group that already lists components, tags, and resources), not a subsystem.

**The former RFC-006 "identity index" dissolves.** Under the tombstone doctrine there is no resurrection-under-new-id inside the horizon, so the index's reason to exist (remapping a dead id on undo) is gone. What remains — `getEntitySnapshot`/`restoreEntitySnapshot` and an optional app-level GUID map for the wire — is recipe, not kernel feature. It does not need its own RFC.

This leaves a genuine fork, and the RFC does **not** pre-decide it (see Open Questions): tombstone-everything (zero identity machinery, at the cost of `Not(Tombstoned)` discipline) vs a blessed GUID/snapshot identity module (deletes via `destroyEntity` with the corpse carried in the undo record, at the cost of an identity module and claim discipline). The kernel additions here serve **either** path, so the fork can — and per §11 *must* — be settled by building the consumer, not by drafting another speculative RFC.

---

## Adoption plan — gated on a built consumer

The failure mode of RFC-004 and RFC-005 was speccing against consumers that did not exist, within 48 hours of conception. The hard lesson, encoded as a gate: **build the undo recipe in `infinite-canvas` against a branch before promoting or deleting anything.**

1. **v0.14 (mostly additive, ships first):**
   - the serial change-delivery queue + the sync-channel depth guard (a documented behavioral hardening);
   - `changes()` and `getRegisteredRelations()`;
   - **deprecate** the eight buffer queries and `clearDirty` with errors that point at `changes()` (do not delete yet);
   - docs promote the tombstone doctrine to the official identity architecture and state the partition rule once, on `WorldChanges`.
2. **v0.14.x–v0.15 (the gate):** build the undo recorder + sync outbox in `infinite-canvas` against the branch. Ship `onChanges` and origin-run sealing **only when that recipe works end-to-end.** Ship the `/react` hooks subpath.
3. **v0.16:** delete the deprecated members; promote whatever `/changes` utilities the app copied verbatim; decide `patchComponent`'s fate and scheduler consolidation **separately**.

Abandonment stays cheap at every step: the net public-surface delta is **−9 subsumed / −2 internalized / +3 added** (55 → 47), and v0.14 is reversible because it only *adds* and *deprecates* (the buffer deletions land in v0.16, not v0.14).

---

## Principles, after this RFC

The shipped five stand; exactly one is amended, and one is strengthened. (RFC-005's rewrites of #3 and #5 — and its clock eviction — are withdrawn with it.)

1. **Absence is never silent.** *(unchanged — strengthened: `removed` carries the dying value in the delivered form too.)*
2. **One ownership rule.** *(unchanged — now load-bearing: immutable snapshots are why change-set retention is zero-copy.)*
3. **Events are the journal; change detection is the partition.** *(amended from "buffers are the partition" — the partition's public form is the `WorldChanges` you query or the `DeliveredChanges` you receive; the buffers become an implementation detail. The events remain the lossless capture layer; every change set is a window over them, which is RFC-004's surviving insight.)*
4. **Entity first.** *(unchanged — `changes.changed(type)` returns entity-keyed maps.)*
5. **The tick is one call — and the tick delivers.** *(strengthened: `tickWorld` is the sole delivery point; no second clock, no loop object, no public `flush`/`commit` method.)*

---

## Non-goals

1. **Atomicity / rollback.** A change set is a *delivery* unit, not a transaction. Mutations apply immediately; a mid-tick throw leaves applied writes applied. App-level rollback is `applyChanges(invertChanges(partialChanges))` if ever needed. (Same property RFC-005 disclaimed — kept, without the misleading `batch` name.)
2. **Replacing the sync events.** They are the *react* channel; they stay forever. This RFC adds the *record* channel beside them.
3. **A fold monoid as a public law.** `mergeChanges` is an optimization; reverse-order application is the correctness path.
4. **Kernel identity / GUID machinery.** Tombstones dissolve it; GUIDs are an app-boundary recipe.
5. **Clock eviction / `createTickLoop` / `TickContext`.** Withdrawn with RFC-005. `changes()` serves the intra-frame reader without a new time object.
6. **Library-defined origin constants.** Vocabulary stays application policy (RFC-003 non-goal, upheld).

---

## Resolved questions

- **Q1 — keep the sync events, or move all delivery to the tick boundary (RFC-005)?** Keep them. Cleanup and same-tick-transient resources *cannot* be served by a net change set; fine-grained UI and invariants want the moment. Two channels with a one-sentence doctrine beats one channel that cannot express half the consumer table.
- **Q2 — `batch()` or `withOrigin`-runs?** Runs. `withOrigin` already delimits attribution; a second scoping construct with atomicity-implying naming is exactly the surface the author objected to.
- **Q3 — a serial delivery queue on the sync channel too?** No — only on the delivery channel. The delivered change set is computed from baselines, not by replaying events, so sync-channel ordering is not load-bearing for it; imposing a queue there would only tax `mutationOrigin`. The sync channel gets a depth guard, nothing more.
- **Q4 — a public `flush()`/`commit()` method?** No. `tickWorld` is the sole delivery point; `tickWorld(world)` with no fn is the flush path. One delivery concept, not two.
- **Q5 — fold monoid?** No. Reverse-order application removes the need; `mergeChanges` is an optional optimization.

---

## Open questions, walked through

The first review of this RFC settled five of these and sharpened the rest. They are grouped by how much is actually still open.

### Decided in this revision — promoted to spec

- **Q2 — Run-grain vs tick-grain `WorldChanges`: run-grain, not optional.** A tick can contain `[local, remote, local]`; undo must filter `HISTORY` and sync must filter `REMOTE`, which a single mixed-origin tick's change set cannot express without either throwing on mixed-origin ticks (RFC-005's tax) or forcing remote applies through a private flush. Origin-run sealing handles it natively — and the seal-time `next`-freezing the review exposed (§"Sealing freezes the run's `next` values") is required for *correctness* regardless of grain, so the run machinery is load-bearing either way. Cost is one origin comparison per mutation; the common single-origin tick collapses to one run whose window equals the tick. The gate (§11) is on *exposing `onChanges` publicly*, not on the mechanism — the mechanism is the design.

- **Q3 — The two `prev`s: a specified fact, not a choice.** `changes().changed(C).get(e).prev` is the **tick-start** value (whole-tick live window); a delivered `DeliveredChanges.changed(C).get(e).prev` is the **run-start** value, frozen at seal. They differ only when origin switches mid-tick, and each is the correct baseline for its consumer (a spatial index wants net-since-tick-start; a journal wants net-per-attributed-run). This is now precisely specified, not left to taste; it is pinned by the property tests in §"Test plan" (both windows asserted against `classifyTransition`).

### Resolved by drawing the line — not library decisions

- **Q1 — The identity "fork" is really a layering.** Tombstone and GUIDs are not competitors; they serve different ranges. *In-horizon undo* uses tombstones (zero identity machinery — the entity never dies, so raw-`EntityId` journal entries stay valid). The *wire/disk/clipboard boundary* uses GUIDs (ids can't travel a socket or a file). The only thing genuinely undecided is whether the library *ships* a blessed GUID/snapshot module or leaves it as app code — and the admissibility test answers that: it is buildable in user-land today once `getRegisteredRelations()` lands (which it does here), so it stays an app recipe until a second consumer earns the blessed import. Tombstone is the documented undo doctrine; the `infinite-canvas` build confirms ergonomics, not direction.

- **Q5 — Undo-vs-remote same-key conflict is app policy, and the library already gives it what it needs.** Change sets carry `prev`, so both resolutions are app-buildable: the documented recipe defaults to **last-writer-wins** (the straightforward `applyChanges` replay), and shows a **prev-mismatch skip** (compare the change set's `prev` to current; `onMissing: 'skip'`-style no-op on divergence — the Figma model) as a ~5-line opt-in. The kernel takes no position; it ships the `prev` that lets the app take one.

- **Q6 — `patchComponent` stays; it's out of scope.** Its fate is a *write-API* question, orthogonal to change *delivery*. Collapsing it to a spread recipe would forfeit the strict-merge-throws-on-absent guarantee (principle 1, absence is never silent). Decide it separately if ever; the lean is keep.

- **Q7 — Scheduler consolidation stays orthogonal.** Merging `SystemScheduler` + `PhasedScheduler` into one `createSchedule` is a real 1.0 question, but bundling it here would couple two independent breaking changes and blur this RFC's one job. Keep separate.

### Genuinely open — a lean, to confirm by building

- **Q4 — Class instances in document state: lean dev-warn + written scoping.** The ownership rule already holds class instances *by reference*, so a change-set entry for one carries a reference where `prev` may `=== next`, and "lossless undo" cannot be honestly promised for it. Forbidding plain-data-only documents is too strict (people legitimately put `Map`/`Set`/class instances in components); accepting silently makes the headline claim a lie. The middle path: scope "lossless" to plain data **in writing**, treat invert/apply of by-reference components as declared app policy, and **dev-warn when a by-reference component lands in a *retained* change set** (held past its tick). Confirm the warning's ergonomics against the `infinite-canvas` document model before committing.

- **Q8 — Async origin: lean explicit `origin` on the blessed apply helpers.** `withOrigin` stays ambient-and-synchronous (RFC-003 doctrine: re-enter after `await`). But the two consumers that actually cross async boundaries — remote apply and undo replay — both go through `applyChanges`, so giving `applyChanges(world, d, { origin })` an explicit parameter (it wraps a synchronous `withOrigin` internally) makes attribution travel *as data* for exactly the callers that need it, sidestepping the await-loses-origin trap without any `AsyncLocalStorage` machinery. Manual call sites keep the doctrine.

- **Q9 — The `freeze: 'auto'` default (new — see §"The immutability contract is now load-bearing").** Retained change sets make in-place mutation of a stored value a *correctness* bug, not just a hygiene one. Flipping `freeze` from opt-in boolean to `NODE_ENV`-gated `'auto'` is self-contained and shippable on its own minor, but carries a hard dependency on this RFC: **if `onChanges` ships, `'auto'` should ship no later.** Lean: ship it alongside v0.14.

---

## Test plan (when adopted)

- **Partition exactness, per window**, re-asserted for both `changes()` (tick window) and `DeliveredChanges` (run window): re-add nets to changed; add-then-remove is invisible; destroy folds its cascade to one net result; relation exclusivity displacement nets to removed(old)+added(new).
- **The two prevs:** `changes().changed(C).get(e).prev` == tick-start value; a delivered `DeliveredChanges.changed(C).get(e).prev` == run-start value, over random mutation sequences.
- **Seal-time freezing:** in `local₁ → remote → local₂` all writing component C, `local₁`'s sealed change set carries C's value *at the local₁→remote boundary*, never `remote`'s or `local₂`'s later writes; `remote`'s `prev` for C equals `local₁`'s `next` for C. A run's `next` is immutable once sealed even as the store's live value moves on.
- **The frame always advances:** a throwing `onChanges` (or `onFrame`) handler does not stop later handlers, does not stop `emitFrame`/`incrementTick`, and `currentTick` has advanced by exactly one when the `AggregateError` surfaces; the aggregate carries every collected throw.
- **Delivery:** serial order; deliver-all on a throwing handler with `AggregateError`; no nested delivery (handler mutations land next tick); window reset-before-deliver (a handler mutation never appears in the change set being delivered); snapshotted subscription list.
- **`changes()` accessor stability:** iterating `changes().changed(C)` while the loop body mutates the world does not throw or skip entries; a second `changes().changed(C)` call in the same tick reflects the new writes.
- **Sync channel preserved:** `onComponentRemoved` fires pre-teardown with the dying value; `mutationOrigin` reads correctly inside handlers; the depth guard throws past threshold instead of overflowing.
- **`/changes` properties:** `invertChanges` is an involution; `applyChanges(world, invertChanges(d))` restores the pre-window state for living entities; `applyChanges` validates before mutating; relation inversion reverses order.
- **Echo suppression:** a `REMOTE` run is dropped by the outbox; a `HISTORY` run is dropped by the recorder but sent by the outbox; cascades inherit origin into one run.
- **Migration:** deprecated buffer queries throw with a message naming `changes()`; `tickWorld(world)` with no fn delivers and advances the frame.

---

## Migration (0.13.1 → 0.14)

| v0.13.1 | v0.14 |
|---|---|
| `queryAdded(C)` / `queryChanged(C)` / `queryRemoved(C)` in a system | `world.changes().added(C)` / `.changed(C)` / `.removed(C)` (now with values) |
| `queryAddedTag(T)` / `queryRemovedTag(T)` | `world.changes().addedTag(T)` / `.removedTag(T)` |
| `queryRelationAdded(R)` / `queryRelationRemoved(R)` | `world.changes().addedRelation(R)` / `.removedRelation(R)` |
| `queryChangedResources()` | `world.changes().changedResources()` |
| `clearDirty()` | gone — the seal→reset inside `tickWorld` |
| reading buffers in an `onFrame` handler | `onChanges(changes)`; `onFrame` is the post-delivery flush hook |
| `onComponentChanged` / `onComponentRemoved` / tags / relations / resources / created / destroyed | **unchanged** — the sync channel stays |
| `withOrigin` / `mutationOrigin` | **unchanged** |
| `currentTick` / `tickWorld` | **unchanged** (clock not evicted) |
| `incrementTick()` / `emitFrame()` called directly | **internal now** — call `tickWorld(world)` (no fn) to advance + deliver a frame |
| `createWorld({ freeze: true })` | unchanged; the `'auto'` default is a separate decision (Open Q9) tied to this RFC |
| the don't-mutate-mid-destroy doctrine | **unchanged** — the sync channel keeps its guard |

Everything not in this table is untouched. The migration is: replace eight presence-only polled reads with one value-carrying `changes()`, and — if you want recorded delivery — subscribe `onChanges`. That is the whole break.
