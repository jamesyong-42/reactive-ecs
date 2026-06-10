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
world.onEntityCreated((id) => { /* ... */ });
world.onEntityDestroyed((id) => { /* cleanup caches */ });
world.onFrame(() => { /* end-of-tick hook */ });

unsub(); // all subscriptions return an Unsubscribe function
```

This is what makes it practical to drive React / Vue / Svelte components from the world — wire the event callbacks to `useState`/`signal`/store updates.

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
- **Resources** — singletons (`defineResource('Camera', { ... })`) — perfect for viewport state, config, or holding a class instance like a spatial index.
- **Cached queries** — `world.query(Position, Velocity, Selected)` returns entity IDs; results are cached and updated incrementally as components/tags are added or removed. Terms are AND-composed; wrap a component or tag in `Not()` to require its absence (`Or` is deliberately absent — run two queries instead):

  ```ts
  import { Not } from '@jamesyong42/reactive-ecs';

  world.query(Position, Not(Velocity)); // positioned entities that are NOT moving
  world.query(Position, Not(Selected)); // negated tags work too
  // At least one positive term is required — query(Not(Velocity)) throws.
  ```

  Not-queries are maintained incrementally like any other: adding the negated type to a matching entity evicts it from the cached result, and removing it re-admits.
- **Change tracking** — `queryChanged`, `queryAdded`, `queryRemoved`, `queryAddedTag`, `queryRemovedTag`, per-tick dirty sets. Removed-buffers include entities torn down by `destroyEntity` so consumers managing external resources (GPU buffers, DOM nodes, subscriptions) get a single channel for "this entity no longer has C."
- **Events** — `onComponentChanged`, `onComponentRemoved`, `onTagAdded`, `onTagRemoved`, `onEntityCreated`, `onEntityDestroyed`, `onFrame`. `onComponentRemoved` fires synchronously before the data is deleted (so `prev` is readable) and also fires during `destroyEntity` for every component the entity owned.
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

## Non-goals

- **Archetype storage / SoA TypedArray packing.** Component data uses plain `Map<entity, T>`. Fine for thousands of entities with rich data; not built for millions of game entities.
- **Parallel / worker execution.** Single-threaded.
- **Serialization format.** Walk the world with `query()` / `getComponent()` — trivial to write your own.

## License

MIT © James Yong
