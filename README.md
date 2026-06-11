# reactive-ecs

[![npm](https://img.shields.io/npm/v/@jamesyong42/reactive-ecs.svg?color=cb3837&label=npm)](https://www.npmjs.com/package/@jamesyong42/reactive-ecs)
[![CI](https://github.com/jamesyong-42/reactive-ecs/actions/workflows/ci.yml/badge.svg)](https://github.com/jamesyong-42/reactive-ecs/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@jamesyong42/reactive-ecs?label=minzipped)](https://bundlephobia.com/package/@jamesyong42/reactive-ecs)

A reactive, dependency-free TypeScript ECS (Entity-Component-System) for UI frameworks — not just game loops.

The focus is **reactivity**: component changes, tag additions, and resource updates all emit events you can subscribe to. Queries are cached and update incrementally. A topological scheduler orders systems by `after`/`before`. Works anywhere TypeScript runs — browser, Node, Bun, Deno. Zero runtime dependencies.

If you want raw per-frame throughput for thousands of game entities, use [bitECS](https://github.com/NateTheGreatt/bitECS) or [becsy](https://lastolivegames.github.io/becsy/). If you want structured world state that a UI can subscribe to without reinventing the plumbing, this is for you.

## Design principles

Every API decision in this library answers to five rules:

1. **Absence is never silent** — reads return `undefined`; non-creating writes against absence throw.
2. **One ownership rule** — plain data crossing the API boundary is owned by the world: cloned in, frozen in dev, replaced never mutated; class instances stay the caller's, by reference.
3. **Events are the journal; buffers are the partition** — events are lossless, synchronous, per-mutation; buffers classify the net transition since the last `clearDirty()` and are disjoint by definition.
4. **Entity first** — every per-entity read/write is `(entity, type, ...)`.
5. **The tick is one call** — `tickWorld` is the door; `emitFrame` / `clearDirty` / `incrementTick` are the escape hatch.

## Install

```bash
npm i @jamesyong42/reactive-ecs
# or
pnpm add @jamesyong42/reactive-ecs
```

## At a glance

```ts
import {
  createWorld,
  defineComponent,
  defineResource,
  defineSystem,
  defineTag,
  SystemScheduler,
  tickWorld,
} from '@jamesyong42/reactive-ecs';

// 1. Define types
const Position = defineComponent('Position', { x: 0, y: 0 });
const Velocity = defineComponent('Velocity', { dx: 0, dy: 0 });
const Selected = defineTag('Selected');
const Camera   = defineResource('Camera', { x: 0, y: 0, zoom: 1 });

// 2. Build a world
const world = createWorld();

const e = world.createEntity();
world.addComponent(e, Position, { x: 10, y: 20 });
world.addComponent(e, Velocity, { dx: 1, dy: 0 });
world.addTag(e, Selected);

// 3. Systems (named, ordered by after/before)
const movement = defineSystem({
  name: 'movement',
  execute: (w) => {
    for (const id of w.query(Position, Velocity)) {
      const p = w.getComponent(id, Position)!;
      const v = w.getComponent(id, Velocity)!;
      w.patchComponent(id, Position, { x: p.x + v.dx, y: p.y + v.dy });
    }
  },
});

// 4. Schedule & tick — tickWorld is the door
const scheduler = new SystemScheduler();
scheduler.register(movement);

function tick() {
  tickWorld(world, (w) => scheduler.execute(w));
}
```

`tickWorld(world, fn)` runs `fn`, then `emitFrame()`, `clearDirty()`, `incrementTick()` — in that order, so `onFrame` subscribers still see this tick's buffers. The manual trio exists as the escape hatch when you need to interleave something between those steps:

```ts
scheduler.execute(world);
world.emitFrame();
world.clearDirty();
world.incrementTick();
```

## The write API — add, patch, remove

Three verbs with disjoint meanings:

- **`addComponent(e, Type, data?)`** — upsert: attach-or-replace. `data` is partial, merged over the type's defaults; omitted data attaches pure defaults. Observers receive the existing value as `prev` on a replace, so `prev === undefined` reliably means first attach.
- **`patchComponent(e, Type, data)`** — strict shallow-merge update of an *existing* component. One level deep; nested objects in `data` replace wholesale. Non-creating by design — absence is never silent:

  ```
  patchComponent(Position): entity 42 does not exist or has been destroyed
  patchComponent(Position): entity 42 has no Position — use addComponent to attach
  ```

- **`removeComponent(e, Type)`** — detach; fires `onComponentRemoved` with the discarded value before deletion.

For writes that may race a destroy (async callbacks, timers, network responses), the idiomatic guard is:

```ts
if (world.entityExists(id)) world.patchComponent(id, Position, { x });
```

A throw from an unguarded write is the library telling you an entity died while you weren't looking — silently dropping the write (or worse, resurrecting the component) would hide the race.

## Reactivity — subscribing to world state

This is the part most ECS libraries skip. Every mutation emits an event:

```ts
// Specific entity
const unsub = world.onComponentChanged(Position, (id, prev, next) => {
  console.log(`entity ${id} moved from ${prev?.x} to ${next.x}`);
}, entityId);

// Any entity with this component
world.onComponentChanged(Position, (id, _, next) => { /* ... */ });

// Fires before the data is gone — `prev` is the soon-to-be-discarded value.
// Also fires for each component an entity owned when destroyEntity is called.
world.onComponentRemoved(Position, (id, prev) => { /* release GPU buffer keyed by prev */ });

world.onTagAdded(Selected, (id) => { /* ... */ });
world.onTagRemoved(Selected, (id) => { /* ... */ });
world.onResourceChanged(Camera, (prev, next) => { /* re-render the viewport */ });
world.onEntityCreated((id) => { /* ... */ });
world.onEntityDestroyed((id) => { /* cleanup caches */ });
world.onFrame(() => { /* end-of-tick hook */ });

unsub(); // all subscriptions return an Unsubscribe function
```

Resources are no exception: `onResourceChanged` fires synchronously inside `setResource` after the shallow merge, with a pre-merge snapshot as `prev` and the live value as `next`.

This is what makes it practical to drive React / Vue / Svelte components from the world — wire the event callbacks to `useState`/`signal`/store updates.

## Change tracking — the partition rule

Events are the journal; buffers are the partition. The per-tick buffers classify every touched entity by its **net transition since the last `clearDirty()`** — and the three buffers are disjoint by definition:

| Net transition since `clearDirty()` | Buffer |
| --- | --- |
| absent → present | `queryAdded` only |
| present → present, ≥ 1 write | `queryChanged` only |
| present → absent | `queryRemoved` only |
| absent → absent | none |

Consequences worth internalizing:

- A fresh attach lands in `queryAdded` only — never `queryChanged`. "New" and "updated" are different downstream actions (create the sprite vs. move it), so they never alias.
- `removeComponent` + `addComponent` of a component that existed at tick start nets to `queryChanged` — the world holds the component before and after, so it was changed, however violently.
- `addComponent` + `removeComponent` within one tick nets to nothing. So does create + add + destroy.
- Tags and relation edges follow the same rule minus a changed buffer — for them present → present is vacuous (re-adding a tag is a no-op).
- `destroyEntity` participates: pre-existing components/tags/edges land in the removed buffers; same-tick ephemera land nowhere.

Events never net-cancel: a remove-then-re-add still fires `onComponentRemoved` and `onComponentChanged(prev: undefined)` in order. If you need every intermediate state, subscribe. **Buffers belong to the tick pipeline; anything on its own cadence subscribes to events.**

Reads are typed read-only: `getComponent` returns `Readonly<T> | undefined` and `getResource` returns `Readonly<T>`. The returned object is the live store value, so write through `patchComponent` / `addComponent` / `setResource` instead of mutating it — that's what keeps the events above firing. In development, `createWorld({ freeze: true })` enforces this at runtime: the world deep-freezes exactly what it clones (plain objects and arrays at any depth — never class instances), so in-place mutation of a read throws in strict mode. Clone and freeze are two enforcements of the same ownership boundary.

## Origin tagging — coexisting observers

Modules that both observe the world *and* mutate it (a sync adapter, an undo journal) collide: each one re-observes its own writes and everyone else's, and suppressing that with private flags means every module consulting every other module's flag — N² coupling. `withOrigin` carries the one fact they need from the mutation call site to the observers:

```ts
const REMOTE = Symbol('remote');
const UNDO = Symbol('undo-replay');

// The sync adapter applies a remote batch without re-broadcasting it:
world.withOrigin(REMOTE, () => {
  world.patchComponent(id, Position, { x: 10 });
});

// The broadcaster skips remote echoes and undo replays:
world.onComponentChanged(Position, (id, prev, next) => {
  if (world.mutationOrigin === REMOTE || world.mutationOrigin === UNDO) return;
  broadcast(id, next);
});

// The undo journal records only what the user did:
world.onComponentChanged(Position, (id, prev, next) => {
  if (world.mutationOrigin !== undefined) return; // not user-originated
  journal.record({ id, type: Position, prev, next });
});
```

Every mutation made synchronously inside `fn` carries the origin; because events fire synchronously, a handler reading `world.mutationOrigin` always sees the origin of exactly the mutation that fired it. Outside any window it's `undefined` — the implicit "local user" origin, which `withOrigin` refuses to set explicitly (origins must be strings or symbols). Nested windows stack (innermost wins, restored on exit, even on throw), `withOrigin` returns `fn`'s return value, and `destroyEntity` cascades — including relation policy effects — inherit the call-site origin. The library defines no origin values and attaches no semantics; the vocabulary is yours.

What it deliberately does **not** do: no batching or deferred delivery — events stay synchronous per-mutation (the name `transact` is reserved for a future RFC that earns it) — and per-tick buffers (`queryChanged` et al.) stay origin-blind, because their consumers converge on *what the world is now*, not on who changed it. One caveat: the window is synchronous — in an async `fn`, mutations after the first `await` are untagged; re-enter `withOrigin` in the continuation.

## Relations

Entity-to-entity references stored as a plain `EntityId` field rot: the inverse ("who points at me?") needs a hand-maintained mirror, and nothing cleans the edge when either endpoint dies. A **relation** is a managed, inverse-indexed edge the world owns:

```ts
import { defineRelation, defineTag } from '@jamesyong42/reactive-ecs';

const Destroyed = defineTag('Destroyed');
const ChildOf = defineRelation('ChildOf', {
  sourceExclusive: true,      // ≤ 1 target per source (one parent) — default false
  targetExclusive: false,     // ≤ 1 source per target — default false
  onTargetDestroy: 'cascade', // children die with their parent — default 'clear'
});

world.relate(child, ChildOf, parent);   // throws if either endpoint is dead
world.getTargets(child, ChildOf);       // → [parent]
world.getTarget(child, ChildOf);        // → parent — convenience for sourceExclusive
world.getSources(parent, ChildOf);      // → all children — the always-coherent inverse
world.unrelate(child, ChildOf, parent); // or omit target to drop ALL of child's edges
```

Like every per-entity call, the entity comes first — `getSources(parent, ChildOf)` reads "who points at `parent`?".

Relating past an exclusivity bound **replaces**: a `sourceExclusive` source relating to a second target unrelates the first (removed-then-added events, like `addComponent` overwrite). Re-relating an existing edge is a no-op.

**The destroy guarantee: no relation edge ever survives the destruction of either endpoint.** When an entity dies as a *source*, its outgoing edges simply vanish. When it dies as a *target*, each incoming edge is removed and the relation's `onTargetDestroy` policy is applied to each source — after the destroy sweep completes, never mid-teardown:

| Policy | Effect on each source |
| ------ | --------------------- |
| `'clear'` *(default)* | none — edge dropped, source lives on |
| `'cascade'` | source is destroyed too (chains and cycles terminate) |
| `{ tag: T }` | tag `T` added to the source |

Edge changes flow through the same two channels as every other primitive — per-tick batches and synchronous observers:

```ts
world.queryRelation(ChildOf);        // all live edges as [source, target] pairs
world.queryRelationAdded(ChildOf);   // edges whose net transition this tick is absent→present
world.queryRelationRemoved(ChildOf); // net present→absent, INCLUDING destroy-driven removals

world.onRelationAdded(ChildOf, (source, target) => { /* ... */ });
world.onRelationRemoved(ChildOf, (source, target) => {
  // Fires synchronously — during a destroy, the dying entity's components
  // and tags are still readable here. Read freely; mutating mid-sweep throws.
}, sourceId); // bare id = per-source filter, like the entityId filter elsewhere

// { target } watches edges INTO an entity — e.g. re-render a parent's child
// list as children come and go (destroy-driven removals included):
world.onRelationAdded(ChildOf, handler, { target: parent });
world.onRelationRemoved(ChildOf, handler, { target: parent });
// { source, target } pins the exact edge.
```

Relations are a side index, never a query key — `world.query()` ignores them, so per-frame edge churn can't thrash the query cache. The litmus for reaching for one: **make it a relation only if you query the inverse.** A reference you only ever read forward is fine as an `EntityId` component field.

## Document state vs. interaction state

In an editor-shaped app the world holds two kinds of entities, and they want different deletion semantics. This is architecture, not a workaround:

- **Interaction entities** — gesture recognizers, pointers, selection chrome, drag ghosts. They churn, lose arbitrations, and die. Delete them with `destroyEntity` and let cascade / `{ tag }` policies tear down their dependents. Their ids appearing in saved data would be a bug.
- **Document entities** — shapes, layers, notes: anything inside the undo horizon. "Deleting" one must be reversible, and ids are never reused, so `destroyEntity` is the wrong verb while undo can still resurrect it. Use a **tombstone tag** and exclude it from document queries:

```ts
const Tombstoned = defineTag('Tombstoned');

// "delete" — fully reversible, id and data intact
world.addTag(shape, Tombstoned);
// undo
world.removeTag(shape, Tombstoned);

// document queries exclude the dead by construction
world.query(Shape, Not(Tombstoned));

// renderers react to the tag like any other state
world.onTagAdded(Tombstoned, (id) => hideSprite(id));
world.onTagRemoved(Tombstoned, (id) => showSprite(id));
```

`destroyEntity` for a document entity then means exactly one thing: **eviction past the undo horizon** — the moment the app guarantees no undo stack, clipboard, or collaborator can ever reference that id again.

## Introspection

For devtools, editors, and serialization, the world can enumerate everything it holds:

```ts
world.getAllEntities();              // EntityId[]  — live entities
world.getRegisteredComponents();     // ComponentType[]
world.getRegisteredTags();           // TagType[]
world.getRegisteredResources();      // ResourceType[]
world.getComponentsOf(entity);       // ComponentType[] — currently attached
world.getTagsOf(entity);             // TagType[]       — currently attached
```

All are O(k) where k is the number of registered types — no hidden scan of entity storage. Combine with `onEntityCreated` / `onEntityDestroyed` / `onComponentChanged` to build a live inspector.

### Restoring a saved world

Serialization stays in user-land (walk the introspection API, keep what your app considers "document"), but the world ships the one primitive user-land can't build: creating an entity under a caller-chosen id. That makes restore id-preserving — every entity reference stored in component data is still valid after load, with zero remapping.

```ts
// save — your own walk, your own format
const snapshot = {
	entities: world.getAllEntities().map((entity) => ({
		entity,
		components: world.getComponentsOf(entity).map((type) => ({
			name: type.name,
			data: world.getComponent(entity, type),
		})),
		tags: world.getTagsOf(entity).map((type) => type.name),
	})),
	nextEntityId, // persist your counter alongside the entities
};

// load — into a fresh world, in ascending id order
for (const e of [...snapshot.entities].sort((a, b) => a.entity - b.entity)) {
	world.createEntityWithId(e.entity);
	for (const c of e.components) world.addComponent(e.entity, typesByName[c.name], c.data);
	for (const t of e.tags) world.addTag(e.entity, tagsByName[t]);
}
world.setNextEntityId(snapshot.nextEntityId);
```

Ascending order matters: ids are never reused, so `createEntityWithId` refuses any id below the internal counter — one `sort()` in your loop keeps that invariant unconditional. Restore the saved counter at the end too, because it can exceed the highest live id (entities destroyed before the save consumed ids), and re-issuing those ids would let stale references captured in saved data point at the wrong thing.

## What it gives you

- **Entities** — opaque integer IDs; creation is O(1), destruction is proportional to the entity's components/tags/edges plus the number of registered stores and query caches.
- **Components** — typed data (`defineComponent('Name', defaults)`); arbitrary shape (numbers, strings, arrays, objects, class instances — not restricted to TypedArrays). `addComponent` is the upsert (partial data over defaults; re-adding replaces, with the existing value as `prev`), `patchComponent` is the strict shallow-merge update that throws on absence, `removeComponent` detaches. Plain data is defensively cloned all the way down (class instances are kept by reference) on every write path; reads come back as `Readonly<T>`, and `createWorld({ freeze: true })` enforces that at runtime in dev.
- **Tags** — zero-data boolean markers (`defineTag('Selected')`).
- **Relations** — managed entity-to-entity edges (`defineRelation('ChildOf', { ... })`) with an always-coherent inverse index and lifecycle cleanup: `relate`, `unrelate`, `getTargets`, `getTarget`, `getSources`, `queryRelation`, `queryRelationAdded`, `queryRelationRemoved`, `onRelationAdded`, `onRelationRemoved`. Exclusivity bounds and `onTargetDestroy` policies (`'clear'` / `'cascade'` / `{ tag }`) per relation type.
- **Resources** — singletons (`defineResource('Camera', { ... })`) — perfect for viewport state, config, or holding a class instance like a spatial index.
- **Cached queries** — `world.query(Position, Velocity, Selected)` returns entity IDs; results are cached and updated incrementally as components/tags are added or removed. Terms are AND-composed; wrap a component or tag in `Not()` to require its absence (`Or` is deliberately absent — run two queries instead):

  ```ts
  import { Not } from '@jamesyong42/reactive-ecs';

  world.query(Position, Not(Velocity)); // positioned entities that are NOT moving
  world.query(Position, Not(Selected)); // negated tags work too
  // At least one positive term is required — query(Not(Velocity)) throws.
  ```

  Not-queries are maintained incrementally like any other: adding the negated type to a matching entity evicts it from the cached result, and removing it re-admits. Why no pure-negative queries? A no-arg `query()` is cheap — it copies the maintained alive set. A pure `Not()` query would need its own cached set re-evaluated on every mutation of the negated types *and on every entity create* — it's that standing maintenance cost, not the one-off scan, that the throw refuses. `disposeQuery(...)` drops a cache entry you're done with; re-querying rebuilds it with one scan (the only full-scan path in the library) and resumes incremental maintenance.
- **Change tracking** — `queryChanged`, `queryAdded`, `queryRemoved`, `queryAddedTag`, `queryRemovedTag`, `queryChangedResources` per-tick buffers; see [Change tracking](#change-tracking--the-partition-rule). Removed-buffers include entities torn down by `destroyEntity` so consumers managing external resources (GPU buffers, DOM nodes, subscriptions) get a single channel for "this entity no longer has C." `queryChangedResources` lists the resources set this tick, in first-changed order.
- **Events** — `onComponentChanged`, `onComponentRemoved`, `onTagAdded`, `onTagRemoved`, `onResourceChanged`, `onEntityCreated`, `onEntityDestroyed`, `onFrame`. `onComponentRemoved` fires synchronously before the data is deleted (so `prev` is readable) and also fires during `destroyEntity` for every component the entity owned.
- **Introspection** — enumerate entities, registered types, and per-entity component/tag composition for editors and debugging tools.
- **Scheduler** — `SystemScheduler` orders systems via `after` / `before` with Kahn's topological sort (stable on registration order). Constraints are validated at first execute: one naming an unregistered system throws, naming both parties — a typo must not silently reorder the pipeline.
- **Phased scheduler** — `PhasedScheduler` runs systems in a caller-defined phase order. You declare the phases at construction time (`new PhasedScheduler({ phases: [...] })`); the library ships zero phase opinions. Within a phase, the same `after` / `before` constraints continue to topo-sort; cross-phase ordering is implicit in phase order, and cross-phase constraints that contradict it are rejected.
- **Optional profiler hook** — attach any `{ beginSystem, endSystem }` object (with optional `beginPhase` / `endPhase`) to `scheduler.profiler` for tracing.

## Phased scheduling

`SystemScheduler` is order-by-constraint and order-only. Once your project grows past a handful of systems, the constraint graph stops describing _intent_ and starts describing _accident_ — `after: 'cull'` works but doesn't say _why_, and a new contributor has to read the whole graph to know what runs when.

`PhasedScheduler` adds named phases that you declare at construction time. The library ships no phase vocabulary — it's purely the mechanism (bucketing + cross-phase validation + profiler instrumentation). Pick names that match your domain; a UI tool, a game engine, and an agent simulator each want a different set.

```ts
import { createWorld, defineSystem, PhasedScheduler } from '@jamesyong42/reactive-ecs';

const world = createWorld();
const scheduler = new PhasedScheduler({
  phases: ['input', 'react', 'simulate', 'derive', 'present', 'cleanup'] as const,
  defaultPhase: 'derive', // optional — applied when a system has no `phase`
});

scheduler.register(defineSystem({
  name: 'drainInput', phase: 'input',
  execute: (w) => { /* fold raw events into ECS */ },
}));
scheduler.register(defineSystem({
  name: 'spatialIndexSync', phase: 'react',
  execute: (w) => { /* maintain invariants from prior writes */ },
}));
scheduler.register(defineSystem({
  name: 'physics', phase: 'simulate',
  execute: (w) => { /* time-driven mutations */ },
}));
scheduler.register(defineSystem({
  name: 'frameChanges', phase: 'present',
  execute: (w) => { /* build outputs renderers will read */ },
}));

function tick() {
  tickWorld(world, (w) => scheduler.execute(w));
}
```

Within a phase, `after` / `before` continue to topo-sort. Across phases, ordering is implicit in phase order — a system in an earlier phase always runs before a system in a later one. Cross-phase `after` / `before` references that CONTRADICT phase order (e.g., a `react`-phase system declaring `after` a `derive`-phase system, or `before` an earlier-phase one) are rejected at first execute; redundant ones — `after` a system in an earlier phase, `before` one in a later phase — are allowed, because phase order already satisfies them.

Both schedulers also reject a constraint that names a system that was never registered, at first execute:

```
System 'render' declares after: 'phsyics', but no system named 'phsyics' is registered.
```

Validation is deferred to execute (not register), so systems can be registered in any order. There is deliberately no "optional dependency" escape: **optional-dependency ordering across app configurations is what phases are for** — `phase: 'derive'` says "after all simulation, whatever simulation is installed" without naming any particular system.

### `PhasedSchedulerOptions`

| Field          | Required | Description |
| -------------- | -------- | ----------- |
| `phases`       | yes      | The phase order, earliest first. Must be non-empty and contain no duplicates. Use `as const` on the array literal to get type-narrowed phase strings throughout the API (e.g. on `getPhase()`'s return type). |
| `defaultPhase` | no       | Phase used when `register()` is called with a system that has no `phase`. If unset, registering an unstamped system throws — phase membership becomes mandatory at the call site. |

### Phase membership is validated at register time

```ts
const s = new PhasedScheduler({ phases: ['a', 'b'] as const });
s.register(defineSystem({ name: 'x', phase: 'unknown', execute: () => {} }));
// Error: system 'x' uses phase 'unknown', which is not in configured phases ["a","b"].
```

### Examples of different phase vocabularies

```ts
// 2-phase render loop
new PhasedScheduler({ phases: ['update', 'render'] as const });

// Phaser-style physics game
new PhasedScheduler({
  phases: ['ingest', 'react', 'control', 'applyPhysics', 'cleanup'] as const,
});

// Agent simulator
new PhasedScheduler({ phases: ['perceive', 'think', 'act'] as const });
```

### When to use which

- **`SystemScheduler`** — small projects, custom pipelines, anything where you'd rather express order via constraints than phases.
- **`PhasedScheduler`** — projects past ~6–8 systems, especially when you have observers / invariant maintenance / state machines mixed with derived-state computation. Phases give the new contributor a one-line answer to "when does this run?" (the phase) without having to trace `after` / `before` chains.

Both schedulers are public; pick per-project. `PhasedScheduler` uses `SystemScheduler` internally per phase, so the within-phase semantics are identical.

## Profiler hook

The scheduler accepts any object matching the `SystemProfiler` interface:

```ts
import { type SystemProfiler, SystemScheduler } from '@jamesyong42/reactive-ecs';

const profiler: SystemProfiler = {
  beginSystem: (name) => performance.mark(`${name}-start`),
  endSystem:   (name) => {
    performance.mark(`${name}-end`);
    performance.measure(name, `${name}-start`, `${name}-end`);
  },
  // Optional — only consulted by PhasedScheduler.
  beginPhase: (phase) => performance.mark(`phase:${phase}-start`),
  endPhase:   (phase) => {
    performance.mark(`phase:${phase}-end`);
    performance.measure(`phase:${phase}`, `phase:${phase}-start`, `phase:${phase}-end`);
  },
};

const scheduler = new SystemScheduler();
scheduler.profiler = profiler;
```

The scheduler knows nothing about performance measurement — it just calls the hooks if present. `beginPhase` / `endPhase` are optional, so existing profilers work with either scheduler unchanged.

## Run conditions

A system can declare a `runIf` predicate (the same shape as Bevy's `run_if`). It's evaluated immediately before the system would run, inside the same tick — so it sees writes from systems that ran earlier this tick. Return `false` to skip this tick. The library attaches no change-detection policy; the predicate is yours. The classic shape is a `queryChanged` guard:

```ts
const recompute = defineSystem({
  name: 'recompute',
  runIf: (w) => w.queryChanged(Position).length > 0,
  execute: (w) => { /* expensive derived-state pass */ },
});
```

When a skip happens, the profiler's optional `skipSystem(name)` hook is called instead of `beginSystem` / `endSystem`, so skips stay observable in traces. Works identically inside `PhasedScheduler` phases (a phase still gets its `beginPhase` / `endPhase` bracket even if every system in it skips).

One ordering caveat: per-tick buffers are cleared at end of tick, so order systems that lazily READ a type after the systems that WRITE it (phases make this natural) — a write that happens after the guard ran this tick is invisible to next tick's guard.

## Devtools

The library ships its own devtools — a headless lifecycle recorder (`./devtools`) plus two React components (`./devtools/react`): `EntityTimeline`, a canvas-rendered waterfall of entity lifecycles (pan, zoom, live-tail, ms ⇄ ticks), and `EcsInspector`, a draggable floating window with a live entity/component view and the timeline as a tab. Styles self-inject; nothing to configure:

```tsx
import { createLifecycleRecorder } from '@jamesyong42/reactive-ecs/devtools';
import { EcsInspector } from '@jamesyong42/reactive-ecs/devtools/react';

const recorder = createLifecycleRecorder(world); // before entities spawn

<EcsInspector world={world} recorder={recorder} />
```

Identity is read off composition through one seam: an `EntityDescriber` is a function `(world, entity) => { label, color?, detail?, outcome? }`. The default describer needs zero config — it labels an entity by its first component name (else first tag, else `entity`) and lists remaining tags as detail. Pass your own describer to brand entities with domain labels, bar colours, a live detail string (e.g. a state-machine phase), and a `'win' | 'lose'` outcome that draws the timeline's green/red end-cap. Both the inspector's entity list and the timeline render from the same describer, so labels stay single-sourced.

The recorder captures lifecycle from the world's event hooks (`onEntityCreated` / `onEntityDestroyed`) rather than polling, so entities born and destroyed within a single tick are still recorded — a UI poll would miss them entirely. Because destroy listeners fire before component teardown, the recorder freezes a dying entity's full descriptor at the moment of death; live entities are described on the fly.

`react` is an optional peer dependency used only by `./devtools/react` — the core `@jamesyong42/reactive-ecs` import path is unaffected.

## Non-goals

- **Archetype storage / SoA TypedArray packing.** Component data uses plain `Map<entity, T>`. Fine for thousands of entities with rich data; not built for millions of game entities.
- **Parallel / worker execution.** Single-threaded.
- **Serialization format.** Walk the world with `query()` / `getComponent()` — trivial to write your own.

## License

MIT © James Yong
