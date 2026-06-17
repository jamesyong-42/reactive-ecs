# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.15.0...reactive-ecs-v0.16.0) (2026-06-17)


### ⚠ BREAKING CHANGES

* remove the deprecated per-tick buffer queries + clearDirty (RFC-006 v0.16)

### Features

* remove the deprecated per-tick buffer queries + clearDirty (RFC-006 v0.16) ([31d92da](https://github.com/jamesyong-42/reactive-ecs/commit/31d92dad2f6fa0498093ad0895d75bc597901152))

## [0.15.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.14.0...reactive-ecs-v0.15.0) (2026-06-17)


### Features

* onChanges + applyChanges — two-channel change detection (RFC-006 v0.15) ([c2a0651](https://github.com/jamesyong-42/reactive-ecs/commit/c2a065178340067243f4fe50d85500e3f1051301))

## [0.14.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.13.1...reactive-ecs-v0.14.0) (2026-06-17)


### Features

* changes() value-carrying change detection (RFC-006 v0.14) ([6ef15d9](https://github.com/jamesyong-42/reactive-ecs/commit/6ef15d954ce167035500c6d1d9c16bfe86fe87ff))
* changes() value-carrying change detection (RFC-006 v0.14) ([a78b5e3](https://github.com/jamesyong-42/reactive-ecs/commit/a78b5e3d39e698aeddd3fb14b791a5af4580212d))

## [0.13.1](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.13.0...reactive-ecs-v0.13.1) (2026-06-11)


### Bug Fixes

* small-findings pass — frozen defaults, private scheduler flag, guard uniformity ([0cc0245](https://github.com/jamesyong-42/reactive-ecs/commit/0cc02459ac4e4ecb7f6ee266506f3d659b555e80))
* small-findings pass — frozen defaults, private scheduler flag, guard uniformity ([e25b169](https://github.com/jamesyong-42/reactive-ecs/commit/e25b169409b90e10eb50aba376b616d7a18d8f42))

## [0.13.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.12.1...reactive-ecs-v0.13.0) (2026-06-11)


### ⚠ BREAKING CHANGES

* setComponent and replaceComponent are removed (use patchComponent for strict merge, addComponent to upsert); per-tick buffers reclassified as a net-transition partition; getSources argument order is now (target, type); unknown scheduler constraint targets throw.

### Features

* 0.13.0 design precision — write API, buffer partition, validation, ownership ([7746c80](https://github.com/jamesyong-42/reactive-ecs/commit/7746c803b9a88ebd6ad92fe19e800cec842b9c5e))


### Bug Fixes

* carry the 0.13.0 release + bump-minor-pre-major ([1281608](https://github.com/jamesyong-42/reactive-ecs/commit/1281608faa7226786219f653c2bf7f6db670b364))

## [0.12.1](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.12.0...reactive-ecs-v0.12.1) (2026-06-10)


### Bug Fixes

* defensive clone on set paths + readonly event payloads ([661507b](https://github.com/jamesyong-42/reactive-ecs/commit/661507bfc961f83de84ad7f24c1d075548eaf234))
* **world:** defensive clone on setComponent/setResource; readonly event payloads ([57f8b7a](https://github.com/jamesyong-42/reactive-ecs/commit/57f8b7a6503fef2665dd420dd6c93a013c760594))

## [0.12.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.11.0...reactive-ecs-v0.12.0) (2026-06-10)


### Features

* **core:** tickWorld frame helper ([231e1c7](https://github.com/jamesyong-42/reactive-ecs/commit/231e1c7b1d54d0042d3633f00cc704116a78f7cd))
* **types:** readonly component and resource reads ([deacdd7](https://github.com/jamesyong-42/reactive-ecs/commit/deacdd762d762950926909923fc2587f39a5e5fb))
* **world:** relation observer target filters ([5c679a0](https://github.com/jamesyong-42/reactive-ecs/commit/5c679a024468b551f91b3798b588c41bdfc1133e))
* **world:** replaceComponent ([bad75d7](https://github.com/jamesyong-42/reactive-ecs/commit/bad75d7e597eb0d7a8ad7cdcbe020acad9d35900))


### Bug Fixes

* query-cache aliasing + honest addComponent; feat: replaceComponent, target filters, tickWorld, readonly reads ([cd2ffce](https://github.com/jamesyong-42/reactive-ecs/commit/cd2ffceb6c267665230ccf0e6ed1d17f04c6481a))
* **query:** kind-prefixed cache keys prevent component/tag name aliasing ([588b436](https://github.com/jamesyong-42/reactive-ecs/commit/588b43681f116e32a95047cebbfa84bf4acabe77))
* **world:** honest addComponent semantics, recursive defensive clone, Partial typing ([6d7a61b](https://github.com/jamesyong-42/reactive-ecs/commit/6d7a61b45303f7063a0bd23cfb98d9f316df2690))

## [0.11.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.10.0...reactive-ecs-v0.11.0) (2026-06-10)


### Features

* **devtools:** EcsInspector floating window ([baf6a61](https://github.com/jamesyong-42/reactive-ecs/commit/baf6a61b02464538dc1739859055d4724bb26212))
* **devtools:** EntityTimeline canvas waterfall component ([0c53ef4](https://github.com/jamesyong-42/reactive-ecs/commit/0c53ef4e571ffb7728b6ab20055ba34c9de06e78))
* **devtools:** headless lifecycle recorder with pluggable describer ([7a68bda](https://github.com/jamesyong-42/reactive-ecs/commit/7a68bdaa925f642e997565ea961f475eba6e17b0))
* out-of-the-box devtools — lifecycle recorder, EntityTimeline, EcsInspector ([f73fc1b](https://github.com/jamesyong-42/reactive-ecs/commit/f73fc1bfa2f0ba598a782526907516e3f05bb610))

## [0.10.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.9.0...reactive-ecs-v0.10.0) (2026-06-10)


### Features

* runIf run conditions + skipSystem profiler hook ([72a2fc5](https://github.com/jamesyong-42/reactive-ecs/commit/72a2fc5b41b0b69ecb0593b2a19a47f9e14f5624))

## [0.9.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.8.0...reactive-ecs-v0.9.0) (2026-06-10)


### Features

* resource change observability ([c900cac](https://github.com/jamesyong-42/reactive-ecs/commit/c900cacb62ec1b197d9a5110019f6348a7a5f36d))
* **world:** onResourceChanged and per-tick changed-resource tracking ([5ab3596](https://github.com/jamesyong-42/reactive-ecs/commit/5ab35964dcdec9928e06fc736e0bfc5ac5e1c2ef))

## [0.8.0](https://github.com/jamesyong-42/reactive-ecs/compare/reactive-ecs-v0.7.0...reactive-ecs-v0.8.0) (2026-06-10)


### Features

* origin-tagged mutations (RFC-003) ([0bc382a](https://github.com/jamesyong-42/reactive-ecs/commit/0bc382af5e5fb0e0201e836867cd31439649e3f1))

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
