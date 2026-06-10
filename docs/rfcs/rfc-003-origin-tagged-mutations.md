# RFC-003: Origin-Tagged Mutations — the Echo-Suppression Primitive

- **Status**: Implemented
- **Author**: James Yong
- **Date**: 2026-06-10
- **Area**: World API · mutation metadata · observer coexistence
- **Drivers**: `@jamesyong42/infinite-canvas` — two planned subsystems (CRDT-based multiplayer sync; journal-based undo/redo) that must observe the world *and* mutate it without re-observing their own writes or each other's.
- **Depends on**: nothing. Composes with RFC-002.1 (relations) and RFC-002.2 (id-preserving restore) but requires neither.
- **Verdict in one line**: one closure variable and one wrapper method let any number of observe-and-mutate modules coexist without pairwise coordination; everything else (what origins mean, who filters what) stays user-land.

---

## Summary

Two additions to `World`:

```ts
world.withOrigin<T>(origin: string | symbol, fn: () => T): T   // tag all mutations inside fn
world.mutationOrigin: string | symbol | undefined               // readable inside any handler (readonly)
```

Every mutation made synchronously inside `fn` carries `origin`; every synchronous observer fired by such a mutation can read it via `world.mutationOrigin`. Mutations outside any `withOrigin` window carry `undefined` — the implicit "local user" origin.

```ts
const REMOTE = Symbol('remote');
const UNDO = Symbol('undo-replay');

// The sync adapter applies a remote batch without re-broadcasting it:
world.withOrigin(REMOTE, () => {
  world.setComponent(id, Position, { x: 10 });
});

// The broadcaster skips remote echoes and undo replays:
world.onComponentChanged(Position, (id, prev, next) => {
  if (world.mutationOrigin === REMOTE || world.mutationOrigin === UNDO) return;
  broadcast(id, next);
});

// The undo journal records only what the user did:
world.onComponentChanged(Position, (id, prev, next) => {
  if (world.mutationOrigin !== undefined) return;  // not user-originated
  journal.record({ id, type: Position, prev, next });
});
```

The library defines **no origin values** and attaches **no semantics** to any origin. It carries the tag from the mutation entry point to the observers; what the tag means is the consumer's vocabulary.

---

## Motivation

### The N² coordination problem

RFC-001 completed the observability table: every mutation fires synchronous observers and lands in per-tick buffers. That contract is what makes the library's planned consumers possible — and it is also, unmodified, what makes them collide.

Consider the modules infinite-canvas will run simultaneously, each of which both **observes** the world and **mutates** it:

| Module | Observes (to…) | Mutates (when…) |
|---|---|---|
| Sync broadcaster | every change → send to peers | applying a remote batch |
| Undo journal | every change → record inverse patches | replaying an undo/redo |
| Derived-state systems | `queryChanged` → maintain indexes | writing derived components |

Without origin information:

- The broadcaster observes the mutations *it just applied* from a remote packet and sends them back — an infinite echo loop. Every surveyed sync system treats suppressing this as a first-class primitive: tlstore pairs `mergeRemoteChanges(fn)` with `store.listen(cb, { source: 'user' })`; Yjs exposes `transaction.origin` / `transaction.local`; the infinitecanvas.cc ECS lesson tags updates with an origin and branches on it.
- The undo journal observes its *own replay* (`undo()` calls `setComponent` to restore `prev`) and records it as a fresh user edit, corrupting the redo stack. tldraw's history enters a "Paused" state during replay; MobX-State-Tree ships `withoutUndo()`; Yjs's `UndoManager` filters by `trackedOrigins`. Same primitive, same reason.
- The journal must also not record the broadcaster's remote applications (a peer's edit is not undoable by *this* user — the Figma/Liveblocks/Yjs convention), and the broadcaster must not re-send undo replays it didn't... actually it must send those (an undo is a real local edit to peers) — which is exactly the kind of per-pair policy decision that the modules themselves must own.

### Why user-land cannot build this correctly

Each module *can* suppress its own writes with a private boolean: set a flag, mutate, clear it, ignore events while the flag is up. That works for **one** module in isolation. The failure is compositional: the journal needs to distinguish the broadcaster's writes from the user's, and the broadcaster needs to distinguish the journal's replays from the sync layer's applications. With private flags, every observe-and-mutate module must import and consult every other such module's flag — N² coupling, and adding a third module means touching the first two. The modules cannot coordinate through the world because the world strips the one fact they need: *which entry point produced this event*.

That fact exists only at the mutation call site, inside the library's emit path. By the admissibility test this library applies to every feature — *can the consumer build this correctly in user-land using the public `World` API?* — the answer here is structurally no. This is the same shape of argument that admitted relations (only `destroyEntity`'s owner can enforce edge cleanup) and id-preserving restore (only the world can set its counter): the library carries the mechanism; the policy stays out.

### Prior art, compressed

| System | Primitive | Used for |
|---|---|---|
| tldraw tlstore | `mergeRemoteChanges(fn)` + listener `source: 'user' \| 'remote'` | echo suppression |
| Yjs | `doc.transact(fn, origin)`, `transaction.origin`, `transaction.local` | echo suppression **and** undo scoping (`UndoManager({ trackedOrigins })`) |
| MobX-State-Tree | `withoutUndo()` middleware scope | replay suppression |
| tldraw history | "Paused" recording state during undo/redo apply | replay suppression |
| Excalidraw Store | increments tagged by change source; history is "the first subscriber" | both |

The convergence is total: a reactive store that wants undo *or* sync grows an origin tag on its mutation path. The only design freedom is surface area — and the precedents agree on minimal: a scoping function and a readable tag.

---

## Specification

### `withOrigin(origin, fn)`

- `origin` is any `string` or `symbol`. The library never interprets it; symbols are recommended to consumers for collision-free vocabularies.
- Sets the world's current origin for the **synchronous duration** of `fn`, then restores the previous value — including when `fn` throws (`try`/`finally`).
- **Re-entrant.** Nested calls behave as a stack: the innermost origin wins while its `fn` runs; exiting restores the enclosing one. No interaction between worlds — the origin is per-world state.
- **Returns `fn`'s return value**, so call sites can wrap expressions without restructuring.
- **Synchronous only.** The window closes when `fn` returns. If `fn` returns a promise, mutations after the first `await` are *not* tagged — async continuations must re-enter `withOrigin`. This is documented, not detected; the library adds no async-context machinery (see Non-goals).

### `mutationOrigin`

- Read-only property; `undefined` outside any `withOrigin` window.
- Because every observer in this library fires **synchronously inside the mutating call** (the established contract from RFC-001), a handler reading `world.mutationOrigin` always sees the origin of exactly the mutation that fired it. There is no race and no ambiguity to specify away — this is the payoff of the synchronous-events design decision.
- Valid anywhere, not just in handlers; a system may read it mid-`execute` (it will see whatever origin its caller established, normally `undefined`).

### Propagation rules

- **`destroyEntity` cascades inherit.** Everything `destroyEntity` does — destroy listeners, per-component `onComponentRemoved`, per-tag `onTagRemoved`, and (once RFC-002.1 lands) the relation sweep and its deferred policy effects (cascade-destroys, tag-adds) — runs inside the originating call frame and therefore observes the origin active at the `destroyEntity` call site. A remote-originated destroy cascades as remote.
- **Per-tick buffers are origin-blind.** `queryAdded` / `queryChanged` / `queryRemoved` and their tag/relation twins aggregate net world deltas regardless of origin. Rationale: their consumers are systems maintaining derived state (spatial indexes, render lists), which must converge on *what the world is now*, not on who changed it. A remote-originated move must update the spatial index exactly like a local one. Consumers needing origin-split streams use the synchronous observers, which is where the origin is readable. (Resolved question Q1 below.)
- **Event signatures are unchanged.** No handler gains a parameter; the origin is pulled, not pushed. (Resolved question Q2.)

### Naming

`withOrigin`, not `transact`. Yjs calls its equivalent `transact(fn, origin)`, but in Yjs the name is earned — the wrapper also batches and defers observer delivery. This library's wrapper does **neither**: events stay synchronous, per-mutation, exactly as before. Calling it `transact` would imply atomicity or batching semantics the method does not have, and this library's surface is precise about its semantics or it is nothing. The name `transact` is deliberately left unclaimed so a future RFC *can* introduce real batching (defer observer delivery until the close of a transaction window) as a separate, honestly-named capability; `withOrigin` would compose with it unchanged.

---

## Implementation sketch

One closure variable in `createWorld`, next to `nextEntityId`:

```ts
let mutationOrigin: string | symbol | undefined;
```

On the returned world object:

```ts
get mutationOrigin() {
  return mutationOrigin;
},

withOrigin<T>(origin: string | symbol, fn: () => T): T {
  const prev = mutationOrigin;
  mutationOrigin = origin;
  try {
    return fn();
  } finally {
    mutationOrigin = prev;
  }
},
```

No emit path changes, no store changes, no per-mutation cost: the existing synchronous handlers simply have something new to read. Zero cost for consumers that never call it.

(`World` already exposes `currentTick` via a getter, so the readonly-property pattern is established; `withOrigin`'s validation is `typeof origin === 'string' || typeof origin === 'symbol'` — anything else throws, keeping `undefined` unforgeable as "no origin.")

---

## What the driver builds on top (illustrative, user-land)

The point of the primitive is what it makes *deletable*. The undo journal sketch:

```ts
const UNDO = Symbol('undo-replay');

journal.undo = () => {
  const group = journal.popUndoGroup();
  world.withOrigin(UNDO, () => {
    for (const patch of group.reverse()) applyInverse(world, patch);
  });
  journal.pushRedoGroup(group);
};
```

— with recording handlers that return early when `world.mutationOrigin === UNDO || world.mutationOrigin === REMOTE`. This replaces the per-command `execute`/`undo` objects in infinite-canvas's `commands.ts` (268 lines) with mechanically derived inverse patches, and lets the future sync broadcaster ship without either module knowing the other exists. The journal, marks/grouping (`beginGroup`-style boundaries at pointerdown/up), stack policy, and the `REMOTE` vocabulary are all application code — see RFC-002.2's companion note on undo-of-destroy id handling.

---

## Non-goals

1. **Batching / atomicity / deferred observer delivery.** Events remain synchronous per-mutation. The name `transact` is reserved for a future RFC if a consumer demonstrates the need (likely trigger: applying large remote batches where per-mutation React re-render scheduling measurably hurts — note React already batches, and per-tick buffers already give batch reads, so the bar is real evidence).
2. **Origin on per-tick buffers** (`queryChangedBy(origin)` etc.). Buffers stay origin-blind per the propagation rules; widen only if a consumer shows a derived-state system that genuinely must split by origin.
3. **Origin parameters on event signatures.** Breaking, and redundant with the readable.
4. **Library-defined origin constants** (`'remote'`, `'undo'`…). Vocabulary is application policy; shipping names would smuggle in the opinion this RFC exists to keep out.
5. **Async-context propagation** (AsyncLocalStorage-style carryover across `await`). Heavy machinery, platform-divergent, and unnecessary for the known consumers — sync application and undo replay are synchronous loops.
6. **Multi-tag origins / origin stacks readable as arrays.** The innermost origin suffices for every surveyed precedent; nesting already restores correctly.

---

## Resolved questions

- **Q1 — should per-tick buffers split by origin?** No. Their consumers converge on world state regardless of who wrote it; origin-aware consumers are exactly the synchronous-observer consumers. (Specified under Propagation rules.)
- **Q2 — origin as a handler parameter?** No — non-breaking readable instead. Synchronous emission makes the readable exactly as precise as a parameter.
- **Q3 — name?** `withOrigin`. `transact` implies semantics this method does not have; reserved for a future batching RFC. (Specified under Naming.)
- **Q4 — string-only origins?** No — allow symbols and recommend them; strings permitted for serializable origin vocabularies (e.g. logging which peer a batch came from).

---

## Tests

- Default: `mutationOrigin` is `undefined` outside any window; a handler fired by a bare `setComponent` reads `undefined`.
- Tagging: handler fired inside `withOrigin(X, …)` reads `X` — for component change, component remove, tag add/remove, entity created/destroyed; both per-entity and wildcard handlers.
- Nesting: `withOrigin(A, () => withOrigin(B, mutate))` — handler reads `B`; after inner exit, mutations read `A`; after outer exit, `undefined`.
- Exception safety: `fn` throws → origin restored; subsequent mutations read the enclosing value.
- Return passthrough: `withOrigin(X, () => 42) === 42`.
- Destroy inheritance: `withOrigin(X, () => world.destroyEntity(e))` — `onComponentRemoved` / `onTagRemoved` / `onEntityDestroyed` handlers all read `X`. (Once RFC-002.1 lands: a cascade-destroyed source's teardown handlers also read `X`.)
- Validation: `withOrigin(42 as never, fn)` and `withOrigin(undefined as never, fn)` throw.
- Async boundary (documenting test): an async `fn`'s post-`await` mutation reads `undefined`.

---

## Versioning & sequencing

Strictly additive — one getter, one method, no behavior change on any existing path. Ships as a minor. No dependency on RFC-002.1/002.2, but recommended order remains 002.2 → 002.1 → this: the known consumers (journal-based undo, sync adapter) each want the earlier RFCs anyway, and sequencing last keeps this RFC's surface from being designed ahead of its first real caller.
