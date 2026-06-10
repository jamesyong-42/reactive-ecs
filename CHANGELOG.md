# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.6.0...reactive-ecs-v0.7.0) (2026-06-10)


### Features

* first-class relations (RFC-002.1) ([1ede273](https://github.com/jamesyong-42/reactive-ecs/commit/1ede273e1246e64b818b8d53c9a02c5d9e82e48e))
* **types:** RelationType, RelationOptions, and relation handler types ([f425799](https://github.com/jamesyong-42/reactive-ecs/commit/f4257991849701312ad10c9e938f155237418aeb))
* **world:** relation destroy sweep with deferred policies ([d2ec45f](https://github.com/jamesyong-42/reactive-ecs/commit/d2ec45f3f5efd7dcfa44d8c72b295b30bca452b2))
* **world:** relation per-tick buffers and observers ([9407fd7](https://github.com/jamesyong-42/reactive-ecs/commit/9407fd712b05a3d603fc7d23adf228bdc790bb66))
* **world:** relation store with relate/unrelate and reads ([5bfe5b5](https://github.com/jamesyong-42/reactive-ecs/commit/5bfe5b50f621b3181dd3341e75ccae5e8e8744a9))

## [0.6.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.5.0...reactive-ecs-v0.6.0) (2026-06-10)


### Features

* Not() query term ([144ee98](https://github.com/jamesyong-42/reactive-ecs/commit/144ee98f45e49467b210f3e5dc6bb57e6dfc9094))

## [0.5.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.4.0...reactive-ecs-v0.5.0) (2026-06-10)


### Features

* id-preserving entity restore (RFC-002.2) ([53d1eca](https://github.com/jamesyong-42/reactive-ecs/commit/53d1ecaec806970974eb3f16245be2bac6c35821))
* **world:** add createEntityWithId and setNextEntityId (RFC-002.2) ([cf1f6e0](https://github.com/jamesyong-42/reactive-ecs/commit/cf1f6e0d829dd2c37347821f7e17579a4976a141))

## [0.4.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.3.0...reactive-ecs-v0.4.0) (2026-05-21)


### Features

* add queryRemoved, queryAddedTag, queryRemovedTag, onComponentRemoved ([61fb251](https://github.com/jamesyong-42/reactive-ecs/commit/61fb251d6b25970b698fa1d92a677b3ea8bf1239))
* queryRemoved + onComponentRemoved + tag-change buffers (RFC-001) ([483580b](https://github.com/jamesyong-42/reactive-ecs/commit/483580beb74b95ee0f7d9cab27c21a0e2c038c91))

## [0.3.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.2.0...reactive-ecs-v0.3.0) (2026-05-14)


### Features

* add PhasedScheduler for caller-defined phase pipelines ([09f0236](https://github.com/jamesyong-42/reactive-ecs/commit/09f0236263757571fbbdffb3329bd93954bdac87))
* add PhasedScheduler for caller-defined phase pipelines ([c7f3a5b](https://github.com/jamesyong-42/reactive-ecs/commit/c7f3a5b278b23ce63d59e64c0ef8ca8ffbd12e86))

## [0.2.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.1.1...reactive-ecs-v0.2.0) (2026-04-21)


### Features

* add entity/component/tag introspection APIs ([4ea453a](https://github.com/jamesyong-42/reactive-ecs/commit/4ea453ab1f32607f7cf02124fcfc6a43c36f9eb5))

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
