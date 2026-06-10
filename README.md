# reactive-ecs

[![npm](https://img.shields.io/npm/v/@jamesyong42/reactive-ecs.svg?color=cb3837&label=npm)](https://www.npmjs.com/package/@jamesyong42/reactive-ecs)
[![CI](https://github.com/jamesyong-42/reactive-ecs/actions/workflows/ci.yml/badge.svg)](https://github.com/jamesyong-42/reactive-ecs/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@jamesyong42/reactive-ecs?label=minzipped)](https://bundlephobia.com/package/@jamesyong42/reactive-ecs)

A reactive, dependency-free TypeScript ECS (Entity-Component-System) for UI frameworks — not just game loops.

The focus is **reactivity**: component changes, tag additions, and resource updates all emit events you can subscribe to. Queries are cached and update incrementally. A topological scheduler orders systems by `after`/`before`. Works anywhere TypeScript runs — browser, Node, Bun, Deno. Zero runtime dependencies.

If you want raw per-frame throughput for thousands of game entities, use [bitECS](https://github.com/NateTheGreatt/bitECS) or [becsy](https://lastolivegames.github.io/becsy/). If you want structured world state that a UI can subscribe to without reinventing the plumbing, this is for you.

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
      w.setComponent(id, Position, { x: p.x + v.dx, y: p.y + v.dy });
    }
  },
});

// 4. Schedule & tick
const scheduler = new SystemScheduler();
scheduler.register(movement);

function tick() {
  scheduler.execute(world);
  world.emitFrame();
  world.clearDirty();
  world.incrementTick();
}
```

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

## Origin tagging — coexisting observers

Modules that both observe the world *and* mutate it (a sync adapter, an undo journal) collide: each one re-observes its own writes and everyone else's, and suppressing that with private flags means every module consulting every other module's flag — N² coupling. `withOrigin` carries the one fact they need from the mutation call site to the observers:

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
world.getSources(ChildOf, parent);      // → all children — the always-coherent inverse
world.unrelate(child, ChildOf, parent); // or omit target to drop ALL of child's edges
```

Relating past an exclusivity bound **replaces**: a `sourceExclusive` source relating to a second target unrelates the first (removed-then-added events, like `setComponent` overwrite). Re-relating an existing edge is a no-op.

**The destroy guarantee: no relation edge ever survives the destruction of either endpoint.** When an entity dies as a *source*, its outgoing edges simply vanish. When it dies as a *target*, each incoming edge is removed and the relation's `onTargetDestroy` policy is applied to each source — after the destroy sweep completes, never mid-teardown:

| Policy | Effect on each source |
| ------ | --------------------- |
| `'clear'` *(default)* | none — edge dropped, source lives on |
| `'cascade'` | source is destroyed too (chains and cycles terminate) |
| `{ tag: T }` | tag `T` added to the source |

Edge changes flow through the same two channels as every other primitive — per-tick batches and synchronous observers:

```ts
world.queryRelation(ChildOf);        // all live edges as [source, target] pairs
world.queryRelationAdded(ChildOf);   // edges added this tick — cleared by clearDirty()
world.queryRelationRemoved(ChildOf); // edges removed this tick, INCLUDING destroy-driven ones

world.onRelationAdded(ChildOf, (source, target) => { /* ... */ });
world.onRelationRemoved(ChildOf, (source, target) => {
  // Fires synchronously — during a destroy, the dying entity's components
  // and tags are still readable here. Read freely; don't mutate mid-destroy.
}, sourceId); // optional per-source filter, like the entityId filter elsewhere
```

Relations are a side index, never a query key — `world.query()` ignores them, so per-frame edge churn can't thrash the query cache. The litmus for reaching for one: **make it a relation only if you query the inverse.** A reference you only ever read forward is fine as an `EntityId` component field.

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

- **Entities** — opaque integer IDs, O(1) create/destroy.
- **Components** — typed data (`defineComponent('Name', defaults)`); arbitrary shape (numbers, strings, arrays, objects, class instances — not restricted to TypedArrays). Shallow defaults merge, deep-clone on add to prevent shared mutation.
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

  Not-queries are maintained incrementally like any other: adding the negated type to a matching entity evicts it from the cached result, and removing it re-admits.
- **Change tracking** — `queryChanged`, `queryAdded`, `queryRemoved`, `queryAddedTag`, `queryRemovedTag`, `queryChangedResources`, per-tick dirty sets. Removed-buffers include entities torn down by `destroyEntity` so consumers managing external resources (GPU buffers, DOM nodes, subscriptions) get a single channel for "this entity no longer has C." `queryChangedResources` lists the resources set this tick, in first-changed order.
- **Events** — `onComponentChanged`, `onComponentRemoved`, `onTagAdded`, `onTagRemoved`, `onResourceChanged`, `onEntityCreated`, `onEntityDestroyed`, `onFrame`. `onComponentRemoved` fires synchronously before the data is deleted (so `prev` is readable) and also fires during `destroyEntity` for every component the entity owned.
- **Introspection** — enumerate entities, registered types, and per-entity component/tag composition for editors and debugging tools.
- **Scheduler** — `SystemScheduler` orders systems via `after` / `before` with Kahn's topological sort (stable on registration order).
- **Phased scheduler** — `PhasedScheduler` runs systems in a caller-defined phase order. You declare the phases at construction time (`new PhasedScheduler({ phases: [...] })`); the library ships zero phase opinions. Within a phase, the same `after` / `before` constraints continue to topo-sort; cross-phase ordering is implicit in phase order, and cross-phase constraints are rejected.
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
  scheduler.execute(world);
  world.emitFrame();
  world.clearDirty();
  world.incrementTick();
}
```

Within a phase, `after` / `before` continue to topo-sort. Across phases, ordering is implicit in phase order — a system in an earlier phase always runs before a system in a later one, and cross-phase `after` / `before` references (e.g., a `react`-phase system declaring `after: 'someDeriveSystem'`) are rejected at first execute.

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
