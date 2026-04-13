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

world.onTagAdded(Selected, (id) => { /* ... */ });
world.onTagRemoved(Selected, (id) => { /* ... */ });
world.onEntityDestroyed((id) => { /* cleanup caches */ });
world.onFrame(() => { /* end-of-tick hook */ });

unsub(); // all subscriptions return an Unsubscribe function
```

This is what makes it practical to drive React / Vue / Svelte components from the world — wire the event callbacks to `useState`/`signal`/store updates.

## What it gives you

- **Entities** — opaque integer IDs, O(1) create/destroy.
- **Components** — typed data (`defineComponent('Name', defaults)`); arbitrary shape (numbers, strings, arrays, objects, class instances — not restricted to TypedArrays). Shallow defaults merge, deep-clone on add to prevent shared mutation.
- **Tags** — zero-data boolean markers (`defineTag('Selected')`).
- **Resources** — singletons (`defineResource('Camera', { ... })`) — perfect for viewport state, config, or holding a class instance like a spatial index.
- **Cached queries** — `world.query(Position, Velocity, Selected)` returns entity IDs; results are cached and updated incrementally as components/tags are added or removed.
- **Change tracking** — `queryChanged`, `queryAdded`, per-tick dirty sets.
- **Events** — `onComponentChanged`, `onTagAdded`, `onTagRemoved`, `onEntityDestroyed`, `onFrame`.
- **Scheduler** — `SystemScheduler` orders systems via `after` / `before` with Kahn's topological sort (stable on registration order).
- **Optional profiler hook** — attach any `{ beginSystem, endSystem }` object to `scheduler.profiler` for tracing.

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
};

const scheduler = new SystemScheduler();
scheduler.profiler = profiler;
```

The scheduler knows nothing about performance measurement — it just calls the hooks if present.

## Non-goals

- **Archetype storage / SoA TypedArray packing.** Component data uses plain `Map<entity, T>`. Fine for thousands of entities with rich data; not built for millions of game entities.
- **Parallel / worker execution.** Single-threaded.
- **Serialization format.** Walk the world with `query()` / `getComponent()` — trivial to write your own.

## License

MIT © James Yong
