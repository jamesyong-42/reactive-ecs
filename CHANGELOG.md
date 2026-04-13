# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.1.0...reactive-ecs-v0.1.1) (2026-04-13)


### Bug Fixes

* tighten type identity, entity guards, scheduler, and resource clone ([b6da0b1](https://github.com/jamesyong-42/reactive-ecs/commit/b6da0b173b2b98fc4e2b2ff5752f39b313ec3834))

## [0.1.0] — 2026-04-13

Initial release.

### Added

- `createWorld()` — entity/component/tag/resource store.
- `defineComponent`, `defineTag`, `defineResource`, `defineSystem` — type-safe definitions.
- Cached queries with incremental updates on component/tag add/remove.
- Per-tick change tracking via `queryChanged` and `queryAdded`.
- Event system: `onComponentChanged`, `onTagAdded`, `onTagRemoved`, `onEntityDestroyed`, `onFrame` — the plumbing needed to drive React / Vue / Svelte from world state.
- `SystemScheduler` with `after` / `before` constraints (stable Kahn's topological sort).
- Pluggable `SystemProfiler` interface — attach any `{ beginSystem, endSystem }` to the scheduler.
- Name-collision detection: duplicate `defineComponent` / `defineTag` / `defineResource` names throw with a clear error on first conflicting use.
- Dead-entity guards: `addComponent` / `addTag` throw when called on non-existent or destroyed entities.
- Deep-cloned defaults: component and resource defaults are deep-cloned so nested arrays/objects aren't shared via the frozen type definition.

[0.1.0]: https://github.com/jamesyong-42/reactive-ecs/releases/tag/v0.1.0
