# RFC-004: Change Cursors — Windowed Change Detection over the Capture Layer

- **Status**: Proposed (adoption gated — see "When to adopt")
- **Author**: James Yong (drafted with Claude)
- **Date**: 2026-06-11
- **Area**: Change detection · consumption layer · `createChangeCursor` · `freeze: 'auto'`
- **Drivers**: `@jamesyong42/infinite-canvas` — state-based sync (send-interval cadence ≠ tick cadence) and gesture-coalesced undo; any future off-cadence consumer of net changes.
- **Depends on**: the v0.13 partition rule (net-transition buffers). Composes with RFC-003 (origin) — cursors can filter by origin.
- **Supersedes**: the "versioned change ticks" candidate previously on the RFC ledger (rejected here, with reasons).
- **Verdict in one line**: the lossless synchronous journal is the capture layer; every coalesced view is a *window* over it — the world ships one window (the tick), and `createChangeCursor` lets any consumer own another, with the exact same partition semantics, built purely on the public API.

---

## The architecture this RFC makes explicit

The library has two change-detection channels. They are not siblings; they are **layers**:

1. **Capture layer — events.** Lossless, synchronous, per-mutation, `prev` included, origin-tagged. Its properties exist for one reason: *capture must be complete at the moment of mutation*, because it records context that no longer exists by end of frame — the dying value, the writing call's origin, the exact order. You can derive any coalesced view from a lossless journal; you can never recover losslessness from a coalesced view.
2. **Consumption layer — windows.** A window coalesces the journal into net transitions between two drain points. The world ships exactly one built-in window — **the tick** (the per-tick buffers, drained by `clearDirty()`) — because it is the only window every app shares: the system pipeline.

Every known consumer is a window size:

| Consumer | Window | Channel today |
|---|---|---|
| Derived-state systems, `runIf` | tick | built-in buffers ✓ |
| UI bindings | frame, addressed per entity | events (framework batches) ✓ |
| Op-based sync (CRDT/OT) | none — raw journal | events + origin ✓ |
| Devtools recorder | none — retained | events ✓ |
| External-resource cleanup | the mutation itself | `onComponentRemoved` ✓ |
| **State-based sync** | **send interval** | **gap — needs a cursor** |
| **Undo/redo** | **user gesture** | **gap — needs a cursor** |

The two gaps share one shape: *a consumer-owned drain point with buffer-identical partition semantics*. That is the whole proposal.

---

## Summary

```ts
import { createChangeCursor } from '@jamesyong42/reactive-ecs';

const cursor = createChangeCursor(world, [Position, Selected, ChildOf, Camera], {
  retainValues: true,                      // keep window-start snapshots (default: false)
  filter: (origin) => origin === undefined, // record only matching mutations (default: all)
});

// …later, on ANY cadence — independent of clearDirty():
const delta = cursor.drain();

delta.added(Position);            // EntityId[] — net absent→present since last drain
delta.changed(Position);          // EntityId[] — net present→present with ≥1 write
delta.removed(Position);          // EntityId[] — net present→absent
delta.addedTag(Selected);         // tags: same partition, no changed buffer
delta.removedTag(Selected);
delta.relationAdded(ChildOf);     // RelationEdge[] — same partition per edge
delta.relationRemoved(ChildOf);
delta.changedResources();         // ResourceType[]
delta.prev(e, Position);          // window-start snapshot (retainValues only)
delta.prevResource(Camera);       //   — covers both changed and removed keys
delta.isEmpty();

cursor.dispose();                 // unsubscribe from the world
```

A cursor is **a blessed consumer, not new world machinery**: it is implemented entirely on the public event API (`onComponentChanged` / `onComponentRemoved` / `onTagAdded` / `onTagRemoved` / `onRelationAdded` / `onRelationRemoved` / `onResourceChanged`), applying the same `classifyTransition` partition against its own private baseline. `World` gains no methods. The built-in buffers are hereby *defined* as the world's own cursor, drained by `clearDirty()` — one concept, two instances.

---

## Motivation

### Why the built-in buffers can't serve off-cadence consumers

The tick buffers have a single, world-owned drain point. Two consumers draining at different cadences starve each other — `clearDirty()` is global. This was stated as a rule in v0.13 ("buffers belong to the tick pipeline; anything on its own schedule subscribes to events") rather than solved, with the fix deferred until a second cadence materialized. The drivers above are that second cadence.

### Why events alone are the wrong consumption shape for these consumers

A state-based sync adapter draining every 50 ms does not want 400 intermediate positions from a drag — it wants *net* changes per send window, including which entities vanished (with enough information to say so). A gesture-scoped undo journal wants one inverse patch per drag, not one per `pointermove`. Both can be hand-built on events — and each hand-build must re-implement the partition classification (baseline-at-first-touch, re-add nets to changed, add-then-remove nets to nothing, destroy folds into removed). That logic is subtle — it took an RFC and a dedicated test suite to get right in core — and consumers will *assume* their hand-rolled semantics match the built-in buffers. Divergence here is a correctness trap, not a style problem.

### The admissibility test, answered honestly

*Can the consumer build this correctly in user-land using the public `World` API?* **Yes** — unlike relations (RFC-002.1) or origin (RFC-003), nothing structural prevents it; events carry everything. That is why this is **not a `World` method**. It enters the library the way `tickWorld` did: a small utility that encodes something easy to get wrong, and the way devtools did: a consumer of public APIs that ships in the box because every serious app will need one and they must all agree on semantics. The cursor's claim to inclusion is *semantic authority* — one shared implementation of the partition rule — not capability.

### Why retained `prev` snapshots are nearly free

Because of the ownership rule (v0.13: replace-never-mutate, clone-on-write, freeze-in-dev), stored values are immutable snapshots. Retaining the window-start value is **retaining a reference** — no copy, no serialization. This is the React lesson (immutable snapshots make reader-owned change detection cost only a reference) paying off concretely: `retainValues: true` costs one Map entry per touched key per window.

---

## Design

### `createChangeCursor(world, types, opts?)`

```ts
type Watchable = ComponentType | TagType | RelationType | ResourceType;

interface ChangeCursorOptions {
  /**
   * Retain the window-start snapshot of each touched key (the value at the
   * cursor's first accepted touch since the last drain). Read back via
   * delta.prev() / delta.prevResource(). Zero-copy — stored values are
   * immutable snapshots, so this retains references, not clones.
   * Default: false.
   */
  retainValues?: boolean;
  /**
   * Record only mutations whose mutationOrigin passes the predicate. The
   * cursor becomes a windowed view of the filtered sub-journal; partition
   * semantics apply to the sub-stream (baseline = state at first ACCEPTED
   * touch). Default: record everything.
   */
  filter?: (origin: string | symbol | undefined) => boolean;
}

function createChangeCursor(
  world: World,
  types: readonly Watchable[],
  opts?: ChangeCursorOptions,
): ChangeCursor;

interface ChangeCursor {
  /** Coalesced net transitions since the last drain (or creation). Resets the window. */
  drain(): ChangeDelta;
  /** Unsubscribe all event handlers. Idempotent. */
  dispose(): void;
}
```

### Semantics — the partition rule, per cursor

Identical to the v0.13 buffers, with the reference point moved from "last `clearDirty()`" to "this cursor's last `drain()`":

- absent→present = **added** · present→present with ≥1 write = **changed** · present→absent = **removed** · absent→absent = **nothing**.
- Tags and relation edges have no changed bucket; their present→present is vacuous.
- Buckets are disjoint by definition. Destroy-driven removals classify identically to explicit ones.
- `prev(entity, type)` (with `retainValues`) is the **window-start** snapshot — defined for keys in `changed` and `removed`; `undefined` for keys in `added` (nothing existed at window start). Note this is *net* semantics: if a value was patched twice then removed, `prev` is the window-start value, not the last value before removal. Instantaneous values belong to the journal (`onComponentRemoved`); window values belong to cursors. This split is deliberate and documented.

### Mechanics

- On creation, the cursor subscribes one wildcard handler per watched type (lazily, per kind). Each handler runs `classifyTransition` against the cursor's private `baseline` maps and bucket sets — the same exported logic the world's buffers use. Handlers never mutate the world, so they are legal during destroy sweeps (the `tearingDown` guard rejects mutation, not observation).
- `drain()` moves the bucket maps into an immutable `ChangeDelta` and allocates fresh internal state — O(1) handoff, no copying. Synchronous events guarantee the delta is a consistent since-last-drain view; there is no tearing.
- `dispose()` unsubscribes everything. A disposed cursor's last delta remains readable.
- **Memory is self-bounding**: cursor state grows with the *touched-key set* per window (≤ world size), never with mutation count — coalescing happens at capture, not at drain. A never-drained cursor on a churning world holds at most one entry per (key, type). With `retainValues`, it additionally holds references to displaced snapshots — same bound.
- **Cost honesty**: each cursor adds one wildcard handler per watched type, so mutation cost grows linearly with live cursor count. Intended scale: a handful per app (sync adapter, undo journal, maybe a devtools panel). Not intended: one cursor per UI component — that's what per-entity event subscriptions are for.

### Relationship to the built-in buffers

The world's per-tick buffers are normatively redefined as *the world's own cursor*, drained by `clearDirty()`. They keep their inline implementation (no indirection on the hot path), but the equivalence becomes a tested invariant: a property test drives a random mutation sequence and asserts `world.queryAdded/Changed/Removed === cursor.drain()` buckets when drained at the same instant. `classifyTransition` moves from a private function to a shared internal module to make "same semantics" literal rather than aspirational.

### Origin filtering and the undo recipe

With `filter`, the cursor windows a *sub-journal*. The flagship recipe — gesture-coalesced undo in ~20 lines:

```ts
const UNDO = Symbol('undo-replay');
const userEdits = createChangeCursor(world, DOCUMENT_TYPES, {
  retainValues: true,
  filter: (origin) => origin === undefined,   // user-originated only
});

function onGestureEnd() {
  const delta = userEdits.drain();
  if (delta.isEmpty()) return;
  undoStack.push(delta);                       // delta IS the inverse patch:
}                                              // prev() per changed/removed key,
                                               // added() keys to delete on undo
function undo() {
  const delta = undoStack.pop();
  world.withOrigin(UNDO, () => applyInverse(world, delta));
}
```

**Documented caveat**: window-based undo is approximate under interleaving — if a remote edit lands on the same key mid-gesture, the user's inverse patch can resurrect remote-overwritten state. This is inherent to windowed undo, not to this cursor; multiplayer apps that need exact interleaving semantics should journal per-mutation (events + origin), the op-based path RFC-003 already serves. Single-user apps (the common case) get exact semantics.

### Companion change: `freeze` defaults to `'auto'`

The cursor design leans on "retained references are trustworthy snapshots," which holds only if nothing mutates stored values in place — the integrity condition of the whole capture layer. v0.13's `freeze: true` enforces it in dev but is opt-in, and opt-in dev safety has a dismal activation rate.

```ts
interface CreateWorldOptions {
  /** Default: 'auto' — enabled when process.env.NODE_ENV !== 'production', off otherwise. */
  freeze?: boolean | 'auto';
}
```

`'auto'` resolves via the standard guard (`typeof process !== 'undefined' && process.env.NODE_ENV !== 'production'`), which every bundler dead-code-eliminates and React/Redux/Immer already normalized. Unresolvable environments (no bundler define, no `process`) resolve to **off** — prod-safe. Semver: minor, with a changelog note (behavioral in dev only).

---

## Alternatives considered

### Versioned change ticks (Bevy/Flecs model) — **rejected**

Stamp every write with a monotonic counter; readers compare against their last-run tick. The throughput-ECS answer, and the previous ledger candidate. Rejected on four grounds:

1. **Forfeits the partition rule.** A stamp records *when* the last transition happened, not *what it net-was from an arbitrary reader's vantage*. (Added tick 5, removed tick 7, re-added tick 9: a reader at cursor 6 should see *changed*; a reader at 8 should see *added*. One stamp cannot serve both.) Bevy accepts the imprecision — re-adds report as adds. We just shipped exactness as a named principle; ticks would un-ship it.
2. **Doesn't cover removals anyway.** The stamp dies with the data. Bevy's `RemovedComponents` is a double-buffered event queue — even the reference implementation falls back to buffered events for a third of the problem.
3. **Wrong cost placement.** Stamps tax every write for every user, including the majority with zero off-cadence readers. Cursors place the cost on the consumers that opt in.
4. **Solves a problem we don't have.** Ticks exist because storage-only ECS libraries lack a journal. We have one; consuming it is strictly more powerful.

### Retained event log with reader offsets (Kafka model) — **rejected**

Exact, general, and the wrong cost model: log growth is bounded by the *slowest reader* (a stalled reader means unbounded memory or a truncation policy that couples all readers), and most consumers would immediately coalesce the log they're handed. Cursors coalesce *at capture*, bounding memory by touched-set size instead of mutation count. The devtools recorder remains the one true log consumer and already exists with its own cap policy.

### Proxy-based auto-tracking (Vue model) — **rejected**

Taxes every read, breaks identity (`proxy !== raw`), and imports a magic dependency graph into a library whose subscriptions are already explicit and cheap. If auto-tracking ever earns a place, it is in an optional framework-binding layer, never the world.

### Do nothing (events are enough) — **rejected, narrowly**

User-land *can* build cursors. But every consumer re-implements the partition classification, every implementation diverges from the buffers in some edge case, and the ecosystem ends with three subtly different definitions of "changed." Shipping one blessed implementation is the same call as `tickWorld`: encode the thing that's easy to get wrong.

---

## What stays user-land

- **Window policy** — when to drain is the consumer's domain knowledge (gesture end, send interval, visibility change). The library never owns a timer.
- **Undo stack semantics** — grouping, limits, selection restoration, redo invalidation.
- **Sync protocol** — wire format, conflict resolution, id-space partitioning (note: the monotonic-id model requires per-peer id ranges for multiplayer creates; `createEntityWithId` throws below the counter by design).
- **Reactive graphs** — computed/derived values, effect scheduling. The library is the feed, not the framework.

## Future work (explicitly out of scope here)

- **Scheduler-owned per-system cursors** — `runIf: changed(Position)` sugar where the scheduler drains a system's private cursor before each run. Recovers Bevy's per-system change detection *inside* this architecture and dissolves the buffer-ordering caveat (a guard compares against its own window, not the global clear). Wants evidence from real `runIf` usage first.
- **`peek()`** (read without reset) — no driver yet; YAGNI.
- **Cursor over a query** (net membership changes of `query(A, Not(B))`) — composable later; no driver yet.

## When to adopt

The gate from the v0.13 review stands: **implement when the first off-cadence consumer is actually being built** (infinite-canvas state sync or gesture undo), not before. This RFC exists so that when that day comes, the design is already settled, the alternatives are already rejected with reasons, and the implementation is a transcription. The `freeze: 'auto'` companion is not gated — it is small, independent, and worth shipping in the next minor.

## Test plan (when adopted)

- Property test: random mutation sequences → cursor drained at instant T equals world buffers cleared at T (bucket-for-bucket).
- The v0.13 partition edge-case suite, re-run against a cursor: re-add nets to changed; add-then-remove nets to nothing; destroy folds into removed; baseline resets per drain.
- `retainValues`: prev is the window-start reference (identity-equal to the displaced snapshot — proving zero-copy); `undefined` for added keys.
- `filter`: filtered-out origins leave no trace; sub-journal baseline semantics (first *accepted* touch).
- Lifecycle: dispose unsubscribes (no further recording); drain during destroy sweep is legal; two cursors at different cadences never interfere with each other or with `clearDirty()`.
