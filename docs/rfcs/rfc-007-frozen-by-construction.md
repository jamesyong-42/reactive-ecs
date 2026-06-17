# RFC-007: Frozen by Construction — Freeze-on-Write Ownership and Functional Updates

- **Status**: Proposed
- **Author**: James Yong (drafted with Claude)
- **Date**: 2026-06-17
- **Area**: Kernel contract · ownership rule · write verbs · immutability
- **Drivers**: The library *simulates* immutability with two defensive mechanisms (clone-on-write + a dev-only deep-freeze) and pays for both on every write. RFC-006 then made retained change sets load-bearing on that immutability — but only *guarantees* it in dev. The shallow-merge `patchComponent` always allocates and always fires, even for a no-op write. There is more clone/freeze machinery in `world.ts` than there is query machinery.
- **Supersedes**: Nothing withdrawn. Replaces the **ownership half** of Principle 2 (the clone/freeze enforcement; the "plain data vs. class instance" boundary is *kept and sharpened*) and the **`patchComponent` write verb**.
- **Depends on**: RFC-003 (origins) and RFC-006 (two-channel change detection) in full — this RFC strengthens RFC-006's central assumption rather than touching its mechanism. v0.16 partition rule, never-reused ids, relations, scheduler: all retained untouched.
- **Verdict in one line**: stop *simulating* immutability and start *having* it — freeze **managed plain data** on write instead of cloning it, and change a component by handing the world a pure function `prev → next` instead of a shallow-merge partial. Clone disappears, the dev/prod freeze split disappears (one walk, no defensive deep clone, every build), no-op writes become free, and RFC-006's retained-diff immutability becomes a guarantee for managed data. The guarantee is **scoped**: borrowed values (class instances, typed arrays, `Map`/`Set`/`Date`) stay the caller's, unfrozen, and outside both immutability and change detection unless replaced. Net public surface: flat (−`freeze` option, `patchComponent`→`updateComponent`, +`updateResource`); net internal machinery: three clone functions and a dev-gate deleted.

---

## The thesis

> Every clone and freeze in the kernel exists to enforce one invariant: **a stored value is immutable; you change it only by replacing it through a verb.** Enforce the invariant *by construction* — one frozen graph, no defensive deep copy — and both defenses, and the proofs that keep them sound, collapse into a single rule.

Today that one invariant is enforced **twice, defensively**, because plain objects are mutable and neither side of the API can be trusted:

- **Clone-on-write** defends against the *caller* keeping a reference and mutating it later — `clonePlainData` (`world.ts:191`), `clonePartial` (`world.ts:226`), and the clone loop inside `instantiateDefaults` (`world.ts:212`).
- **A dev-gated deep-freeze at *write* time** keeps the *consumer* from mutating a read and bypassing change tracking — `deepFreezePlain` (`world.ts:277`) runs through `maybeFreeze` / `freezeEnabled` (`world.ts:309-315`) as values *enter* the store, **dev-only**, so a returned read is immutable only in dev. (It is not "freeze-on-read": the freeze happens on the way in; the read just hands back the already-frozen object.)

Two mechanisms, one goal. And the tell that this is simulation rather than guarantee is in the comments: `patchComponent` (`world.ts:1324-1331`) and `setResource` (`world.ts:1608-1612`) each carry a paragraph *proving* that nested structural sharing is safe ("write paths clone incoming data and stored nested values are only ever replaced, never mutated"). That paragraph is a hand proof of an invariant the runtime does not hold. Frozen values do hold it, and the proof becomes the word "frozen."

This RFC is two moves that share one engine.

---

## The two moves

**Move 1 — Ownership: clone-on-write → freeze-on-write.** Every plain object reachable through a stored value's plain-data spine is deep-frozen *in place*; no defensive deep clone is made. The freeze *is* the ownership transfer, and because frozen plain data cannot be mutated, both the caller-aliasing defense and the consumer-mutation defense are satisfied by the same act. Class instances, typed arrays, and other non-plain values are **borrowed** by reference, exactly as today — the world neither freezes them nor tracks in-place changes to them, so the guarantee is explicitly *scoped to managed plain data* (see "Scope" below).

**Move 2 — Write verb: shallow-merge `patchComponent` → functional `updateComponent`.** You change an existing component by handing the world a pure recipe `(prev) => next`. Because `prev`'s managed plain data is frozen, the recipe cannot mutate it in place — it is forced to produce a new value, so the "never mutate a read" footgun becomes impossible for plain fields instead of merely discouraged. (A *borrowed* field is not frozen; mutating one in place and returning `prev` is invisible to change detection — the contract there is the same as for any read: change it by replacement.) Returning `prev` unchanged is a free no-op.

The moves are separable, but they compose: Move 1 makes Move 2's `prev` genuinely immutable, and Move 2 gives Move 1 its clean call shape and the `Object.is` no-op skip. Ship them together.

---

## Move 1 — Freeze-on-write

### The rule

> **Every plain object (arrays and `{}`-objects) reachable from a stored value *through the plain-data spine* is deep-frozen in place; no defensive deep clone is made. A frozen value is immutable, shared freely, and replaced — never mutated. Non-plain values are borrowed by reference, are not descended into, and remain the caller's to manage.**

Two precisions in that rule. First, *which* objects: the freeze walks plain arrays/objects and **stops at borrowed boundaries** — a plain object held *inside* a borrowed container (a `Map` value, a class-instance field) is reachable from the stored value but is **not** frozen, because the walk does not descend through the borrowed node. "Frozen" means "reachable through managed plain data," not "reachable, period." Second, *which* reference: for a whole-value write (`updateComponent` returning `next`) the value you pass *is* the stored value and is frozen; for a partial write (`addComponent`/`setResource`) the world freezes the *merged result*, which freezes the partial's nested plain objects (now on the store's plain spine) but **not** the partial wrapper itself (never stored).

The plain-data predicate is **tightened** from the one `clonePlainData` uses today (`world.ts:195`: `Array.isArray(v) || v.constructor === Object`) to a **prototype** test — `Array.isArray(v)` or `Object.getPrototypeOf(v)` ∈ `{ Object.prototype, null }` — because `constructor` is a forgeable own/inherited property and the stronger guarantee deserves the honest signal. Everything else — class instances, `Float32Array`, functions, `Map`/`Set`, `Date` — is **borrowed**. For ordinary data the partition does not move (the only behavior change is that a `null`-prototype dictionary now counts as managed, which is correct — it is plain data). Only the treatment of the managed side changes: **freeze, not clone**, traversed over own keys (string *and* symbol), **data properties only** (accessors throw).

### Scope: the guarantee covers managed plain data, not borrowed values

This is the load-bearing boundary, stated once so no claim below overreaches it:

- **Managed = plain arrays and objects** (prototype `Object.prototype` or `null`) **whose own properties are all data properties** — string- or symbol-keyed, enumerable or not. Frozen by construction, immutable, and change-detected: a managed field changes only when it is *replaced*, and replacement is exactly what `addComponent`/`updateComponent`/`setResource`/`updateResource` do. For managed data, "the recipe cannot mutate `prev`" and "every stored value is immutable" are literally true. Accessor properties (getters/setters) and exotic objects (`Proxy`) are **not** managed plain data — they throw or are unsupported (§The freeze function).
- **Borrowed = everything else** (class instances, typed arrays, `Map`/`Set`/`Date`, functions). Stored by reference, **never frozen** (the world can't freeze a `Vector3` without breaking it), and **outside change detection**. The world cannot see an in-place mutation of a borrowed value — no event fires, no buffer entry, and the `Object.is` no-op skip (Move 2) will actively *suppress* a change if a recipe mutates a borrowed field and returns `prev`.

The contract for borrowed values is therefore the same as the contract for any read: **change it by replacement, never in place.** The difference from managed data is only that the world *enforces* it for managed (the freeze throws) and merely *requires* it for borrowed (you must hold the discipline yourself). This is not a new hazard — mutating a read in place has always bypassed tracking; freeze-on-write just draws the enforceable/unenforceable line explicitly, and the no-op skip makes the borrowed case worth restating loudly. If you need a mutable, world-held value, that is precisely what the borrowed path is for — and it costs you change detection on that value until you replace it.

### What it deletes

- `clonePlainData` (`world.ts:191`) — gone.
- `clonePartial` (`world.ts:226`) — gone.
- the clone loop inside `instantiateDefaults` (`world.ts:214-217`) — gone; the function becomes a descriptor-aware merge of the partial over the defaults, then `freezePlain` (not a bare spread — edge case 7).
- `CreateWorldOptions.freeze` (`types.ts:103-114`), `freezeEnabled`, `maybeFreeze` (`world.ts:309-315`) — gone. Freezing is no longer a dev assertion you opt into; it is the mechanism, always on.
- every "this sharing is safe because…" comment in `patchComponent` / `setResource` — replaced by the word "frozen."

`deepFreezePlain` survives, is renamed `freezePlain`, and is promoted from dev-gated assertion to **the single ownership operation**, called on every write where plain data enters a store. `defineComponent` / `defineResource` keep freezing `defaults` at definition time (`define.ts:18`) — that already used this exact mechanism; it is now the same call the writes use.

### The freeze function

Three properties the traversal must have, each closing a hole a looser one would leave: **always descend** (never trust `Object.isFrozen` as proof of depth — a caller's shallow `Object.freeze({ a: { b: 1 } })` would leave `a` mutable); **walk own keys via `Reflect.ownKeys`, not `for...in`** (`for...in` visits *inherited* enumerable keys yet **misses symbol keys and non-enumerable own properties** — a nested object behind a symbol key would silently escape the freeze); and **read each property's *descriptor*** so the data value is reached without ever invoking a getter. It is a **two-pass** operation — a validate/collect pass that can throw, then a freeze pass that cannot (for supported input) — so invalid input throws with **nothing frozen**. The collect pass is a three-colour DFS: a per-call `visiting` set (grey — on the current path) detects real cycles; a `done` set (black) deduplicates shared nodes so a normal DAG like `{ a: shared, b: shared }` is **not** mistaken for a cycle; and an **accessor** property (getter/setter) throws here, because a getter's result cannot be made immutable.

```ts
// "Managed plain data" = arrays + objects whose prototype is Object.prototype or
// null. PROTOTYPE test, not `constructor === Object`: `constructor` is a forgeable
// own/inherited property; the prototype is the honest signal. A class instance,
// typed array, Map/Set/Date, or function is BORROWED — not descended into.
function isManagedPlain(v: unknown): v is object {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function freezePlain(value: unknown): void {
  const done = new Set<object>();
  collect(value, new Set<object>(), done);   // may throw (cycle / accessor); freezes nothing
  for (const node of done) Object.freeze(node); // supported plain data: cannot throw
}

function collect(value: unknown, visiting: Set<object>, done: Set<object>): void {
  if (!isManagedPlain(value)) return;       // primitive or borrowed — stop, don't descend
  if (done.has(value)) return;              // validated already via another parent (shared DAG)
  if (visiting.has(value)) {                // an ancestor on the current path — a genuine cycle
    throw new Error('reactive-ecs: cannot freeze cyclic plain data (component/resource values must be acyclic)');
  }
  visiting.add(value);
  for (const key of Reflect.ownKeys(value)) {            // OWN string AND symbol keys, enumerable or not
    const desc = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in desc)) {                            // accessor (get/set): result can't be frozen
      throw new Error('reactive-ecs: cannot freeze managed plain data with accessor properties (getters/setters)');
    }
    collect(desc.value, visiting, done);                 // data value only — no getter invoked
  }
  visiting.delete(value);                   // pop off the path
  done.add(value);                          // validated; insertion order is the freeze order
}
```

The split is what buys the guarantee: `collect` is the only function that can throw — on a cycle or an accessor — and it never freezes; the freeze loop runs only once the whole graph is validated, and `Object.freeze` on a supported plain object/array cannot throw. So invalid input is rejected with the caller's object **entirely un-frozen** — strictly better than clone-on-write's failure mode (a partial copy, or a stack overflow). Because `visiting` is popped on the way up while `done` persists, two parents pointing at one shared child is a DAG, not a cycle. Two honest limits remain, documented as *unsupported input* rather than silently mishandled: **accessor properties throw** (above), and an **exotic object that masquerades as plain** — in practice a `Proxy` over a plain object, which forwards `getPrototypeOf` and so cannot be told apart — is undefined behavior, since traversing or freezing it runs its traps. Genuine, serializable plain data — the component/resource values this library is built around — hits none of these.

**Cost, honestly.** The thing that goes away is the **defensive deep clone** (`clonePlainData`), not all allocation: `addComponent`/`setResource` still allocate a merged top-level object, and an `updateComponent` recipe still spreads — that shallow construction of the value is inherent and unchanged. What we no longer do is *recursively copy* the incoming graph to defend against aliasing; we deep-*freeze* it instead. One O(value) walk, no second deep copy:

| | clone-on-write (today) | freeze-on-write (this RFC) |
|---|---|---|
| work per write | merge/spread + `O(value)` **deep clone** + (dev) `O(value)` freeze | merge/spread + `O(value)` freeze |
| extra allocation beyond the value built | a full deep copy of the graph | none — the value built is stored as-is |
| dev vs prod | clone always; freeze dev-only | identical in all builds |
| shared subtrees | copied per holder | shared in storage, frozen, immutable |

Note the last row holds regardless of walk cost: `addComponent(e, T)` for two entities stores objects that *share* the same frozen default subtrees by reference — structural sharing in storage is a real memory win even though the freeze walk re-visits them.

**Optional optimization (deferred), to make the walk itself `O(changed)`:** keep a **separate**, world-level `WeakSet` — call it `frozenPlain` — of objects `freezePlain` has *finished* freezing, and let the collect pass short-circuit descent on membership. This is sound *because membership proves world-provenance* (we deep-froze it and completed) — unlike `Object.isFrozen`, which an untrusted caller can fake shallowly. It would make `{ ...prev, x }` skip `prev`'s shared subtrees and walk only the new material. Two things to keep straight (this is its own subtlety): `frozenPlain` must be populated **only in the freeze pass, after the object is actually frozen** — add it during collect and "membership proves frozen" breaks. And it does **not** replace the per-call cycle guard: `frozenPlain` holds *completed* nodes, cycle detection needs *on-stack* nodes (`visiting`) — opposite states, so both structures must exist. Cost: a weak entry per stored plain object (proportional to live store data, GC'd with it). Deferred until a deeply-nested-component workload justifies the memory — the always-descend two-pass above is the correctness baseline, and for the shallow components typical of UI ECS the difference is negligible.

### Structural sharing is now a feature, not a hazard

Two entities created from the same defaults share the *same frozen nested objects*. With clone-on-write that sharing was forbidden (each got a copy); with freeze-on-write it is safe by construction — the only way to "change" a shared subtree is to replace it wholesale, which never touches the other holder. Defaults stop being templates-to-be-copied and become **immutable values to be shared**. Memory drops; GC pressure drops.

### Atomicity: a write that throws changes nothing

`freezePlain` can throw (cycle, accessor), the partial merge can throw (accessor), and an `updateComponent` recipe is user code that can throw. So a write verb must be **all-or-nothing for the kernel**: if value construction, the recipe, or the freeze throws, the world's **stores and change tracking are exactly as they were** — no `store.data` write, no `windowPrev` capture, no `added`/`dirty`/`removed` buffer entry, no run-delta record, no `changedResources` mark, no observer fired. The caller gets the throw; nothing observed it. (This composes with the §"The freeze function" guarantee that the *caller's* graph is also left un-frozen — together: a rejected write touches neither side's managed state.)

The one thing atomicity **cannot** undo is an in-place mutation the recipe made to a **borrowed** object before throwing: `p => { p.vec.x = 5; throw … }` leaves `vec` — a `Vector3` the store still references — mutated, and there is no rollback for arbitrary user side effects on borrowed values. This is the §Scope boundary again, not a gap: managed state is rolled back because the kernel owns it; borrowed objects are the caller's, and their mutations are the caller's to reason about. The honest statement is "the kernel's stores and change tracking are unchanged," not "the world is byte-identical."

This is purely an **ordering** rule in the implementation: do every fallible thing first — build the merged/returned value, then `freezePlain` it — and only then perform the infallible tail (store write → `classifyTransition` → cache update → emit). Today two verbs violate it and must be reordered: `addComponent` captures `windowPrev` *before* building `merged` (`world.ts:1253`), and `setResource` marks `changedResources` *before* cloning/freezing (`world.ts:1607`). The fix is mechanical — move the freeze ahead of the first tracking mutation — and it is the line between a *rejected* bad write and a *half-applied* one that corrupts the tick window and the retained diff. The `updateComponent` sketch below already has this order (recipe → `Object.is` skip → freeze → tracking); the partial verbs must match it.

### Edge cases, decided

1. **Freeze is invasive — that is the contract, and it is a feature.** Any plain object on the store's plain-data spine is frozen, including the *nested* plain objects of a partial you pass to `addComponent`/`setResource` (the partial wrapper itself is not stored, so it is not frozen; its nested plain values are). For object literals born for the call — `addComponent(e, Position, { x, y })`, the overwhelming common case — this is invisible. The one sharp edge is `const s = appState.foo; world.addComponent(e, T, { nested: s })` (or `updateComponent` returning a value that reaches `s`) where the app keeps mutating `s`: that now throws on the app's next mutation, where clone silently tolerated it. **We choose to surface it.** Putting app-mutable plain state into the ECS by reference is exactly the aliasing confusion the clone was papering over; a thrown `TypeError` at the offending mutation beats a silently divergent store. The escape hatch for genuinely-mutable world-held data is the borrowed path (a class instance) — named in §Scope, with its change-detection caveat.

2. **The escape hatch is the existing class-instance boundary — no new knob.** Want the world to hold something it will neither freeze nor copy? Hand it a class instance or a typed array. That is *already* the "by reference, your problem" path; this RFC simply names it **borrowed** and points the fast-path use case at it. We deliberately do **not** add a per-world `borrow` mode or per-component ownership policy (see Rejected Alternatives) — the plain-vs-class line already partitions "managed/frozen" from "borrowed/by-ref," and re-using it keeps the call sites and the world free of flags.

3. **Defaults sharing is sound, and the merge is descriptor-aware.** `defineComponent` deep-freezes `defaults` (themselves accessor-free plain data, since `freezePlain` would have rejected a getter). `addComponent` builds the stored value by merging the partial over the defaults — but **not** a bare `{ ...defaults, ...data }` spread: spread would invoke an enumerable *getter* on the partial before `freezePlain` could reject it (violating "getters are never run by the write path") and would silently drop non-enumerable keys. The merge reads the partial by descriptor instead (edge case 7). The result's nested values are the frozen defaults (shared by reference) plus the partial's data; `freezePlain` then freezes the new top object, re-walking the already-frozen default subtrees (harmless; the optional `WeakSet` would skip them). No instance can mutate a shared subtree because the only write is wholesale replacement, so sharing frozen defaults across instances is safe *and* a memory win.

4. **Typed arrays must not be frozen, and aren't.** `Object.freeze(new Float32Array([1]))` throws in modern engines. The predicate excludes typed arrays (`Object.getPrototypeOf(new Float32Array())` is `Float32Array.prototype`, not `Object.prototype`; `Array.isArray` is false), so they take the borrowed path untouched. No special-casing needed — the managed/borrowed boundary already does the right thing.

5. **A recipe that mutates a *borrowed* field in place and returns `prev` is invisible — by design, restated here because the no-op skip sharpens it.** `updateComponent(e, T, p => { p.vec.x = 5; return p; })` where `vec` is a `Vector3` does change state, but `Object.is(next, prev)` is true, so no event, no buffer entry, no run delta. This is the §Scope boundary in its most concrete form: borrowed values are outside change detection; signal a change by *replacing* the field (`p => ({ ...p, vec: newVec })`). The always-descend freeze means shallow-pre-frozen plain input is now correctly deep-frozen (not trusted and skipped), and cyclic plain input throws a named error before any node is frozen — so the only remaining "you must hold the discipline" case is borrowed values, exactly as §Scope says.

6. **Near-zero cost when there is little plain data.** Primitives and borrowed values return from `freezePlain` in one comparison. A component of only numbers and a `Vector3` pays a single shallow freeze of the top object.

7. **The merge-input contract (`addComponent`/`setResource`).** Both inputs to the merge — the **defaults** and the **partial** — are read as their **own enumerable data properties** (string and symbol keys), symmetrically. Three consequences, specified rather than left to `{ ...spread }` accident: an **accessor (getter) on either throws before the merge** — never invoked, so "getters are never run by the write path" is uniform with `freezePlain`; **non-enumerable own top-level properties are not copied into the instance** — of the partial (a partial is the fields you are assigning, enumerable by definition) *and* of the defaults (a top-level non-enumerable default property is dropped, matching today's spread and the partial rule — don't rely on it reaching instances). The whole-value path has no merge — `updateComponent`'s recipe *returns* the value, which goes straight to `freezePlain`.

   Keep the two contracts distinct: the **merge** decides what gets *into* an instance (own enumerable data props of defaults+partial, top-level); `freezePlain` then makes whatever is in the instance immutable by traversing **all** own keys, enumerable or not, at every depth. So a non-enumerable property *nested inside* a value that was copied in (e.g. a partial's `{ x: objWithNonEnumField }`) **is** frozen — it is part of a value already in the store — while a non-enumerable property at the *top level* of defaults/partial is simply never copied. §Scope's "enumerable or not" describes the freeze traversal of a constructed value; this describes the merge that constructs it.

### Why this is the right time: RFC-006 made it load-bearing

RFC-006 retains sealed `DeliveredChanges` runs whose `prev`/`next` are zero-copy references into the store (`world.ts:898-910`, `sealRun`). The RFC itself flags the hazard — "retained diffs make immutability load-bearing; in-place mutation silently corrupts undo history" — and resolves it with `freeze` as a *dev* boolean. That is a guarantee in dev and a hope in prod. Freeze-on-write makes the values that flow into a retained diff **immutable in every build**. The most consequential correctness assumption in the library stops depending on a default-off flag.

---

## Move 2 — Functional updates

### The rule

> **`updateComponent(entity, type, recipe)` changes an existing component by applying a pure recipe `(prev: Readonly<T>) => T`. It is strict — throws if the entity is dead or lacks the component (absence is never silent), exactly as `patchComponent` does today. The returned value is frozen and stored. Returning `prev` unchanged is a no-op: no write, no event, no buffer entry.**

```ts
interface World {
  /**
   * Transform an existing component via a pure recipe. `prev` is the live value,
   * with its plain data frozen; return the next value (build a new object —
   * plain fields cannot be mutated in place; borrowed fields must be replaced,
   * not mutated, or the change is invisible). Strict: throws if the entity is
   * dead, or alive but lacking the component (use addComponent to attach).
   * Returning `prev` by reference is a no-op — nothing is written, no observers
   * fire, the entity does not enter any change buffer. Origin, events, and the
   * net-transition partition behave exactly as a replace otherwise would.
   */
  updateComponent<T>(entity: EntityId, type: ComponentType<T>, recipe: (prev: Readonly<T>) => T): void;

  /** As updateComponent, for a singleton resource. Returning prev is a no-op. */
  updateResource<T>(type: ResourceType<T>, recipe: (prev: Readonly<T>) => T): void;
}
```

`patchComponent` (`types.ts:364`, `world.ts:1307`) is **replaced**, not joined. Its shallow merge over the *existing* value is expressed as `updateComponent(e, T, p => ({ ...p, ...data }))` — and the more general "compute from prev" and "conditional / no-op" cases it could never express come for free.

**The signature's `Readonly<T>` is a hint, not the depth of the guarantee.** TypeScript's `Readonly<T>` is *shallow*: `prev.nested.x = 1` type-checks and then throws at runtime against the frozen object. That is intentional — immutability here is **runtime-first** (the deep freeze is the guarantee), with `Readonly<T>` supplying light top-level compile friction. We deliberately do **not** ship a `DeepReadonly<T>`: it would wrongly mark *borrowed* nested fields (class instances, typed arrays) as readonly when they are mutable by design (the §Scope boundary the type system can't see), and it bloats inference and error messages. So read the type honestly — TS catches top-level mutation; the freeze catches every level; the two together, not the type alone, are the contract.

### The no-op skip is by reference identity — a crisp contract

```ts
updateComponent(entity, type, recipe) {
  assertNotTearingDown();
  // ... alive + has-component guards (identical to patchComponent today) ...
  const existing = store.data.get(entity) as T;
  const next = recipe(existing);
  if (Object.is(next, existing)) return;     // pure no-op: skip write, event, buffers, run
  freezePlain(next);
  // windowPrev capture, run tracking, store.set, classifyTransition, emit — as patchComponent
}
```

The rule a user learns is one sentence: **return `prev` to mean "nothing changed"; return a new object to mean "changed."** We do *not* deep-compare — `p => ({ ...p })` with identical field values is a change (a new reference), and that is correct: deep equality on every write is a tax, and identity is what a functional update naturally expresses. This makes idempotent updates genuinely free — `update(e, Health, h => h.value > 0 ? h : { ...h, value: 0 })` fires nothing when already clamped, so no spurious re-render, no junk undo entry, no buffer churn. The shallow-merge `patchComponent` could never offer this; it allocated and fired unconditionally.

The one caveat is the §Scope boundary, sharpened: because the skip keys on reference identity, mutating a **borrowed** field in place and returning `prev` is silently a no-op even though state changed. For borrowed values, signal the change by replacing the field (`p => ({ ...p, vec })`). For managed plain data the question can't arise — `prev` is frozen, so the only way to produce a different value is to return a new reference.

### `addComponent` and `setResource` keep their merge shape — on purpose

The asymmetry is intentional and load-bearing:

- **`addComponent(e, T, data?)` stays a partial-over-*defaults* upsert** (`world.ts:1254`). It is the *attach/initialize* affordance — there is no `prev` to compute from at attach time, so a partial over defaults is the right shape (and it must work whether the component is absent or present). `addComponent` initializes; `updateComponent` transforms. Two operations, two shapes, no overlap.
- **`setResource(T, data)` stays a partial-merge** (`world.ts:1604`). A resource always exists (lazily, from defaults), so `setResource` is its initialize-and-write affordance — the analogue of `addComponent`, not of `patchComponent`. `updateResource` adds the functional power form alongside it, the analogue of `updateComponent`.

So the final vocabulary is small and each verb has one job:

| intent | component | resource |
|---|---|---|
| attach / initialize (merge over defaults) | `addComponent(e, T, partial?)` | `setResource(T, partial)` |
| transform existing (recipe `prev→next`) | `updateComponent(e, T, fn)` | `updateResource(T, fn)` |
| detach | `removeComponent(e, T)` | — (singletons persist) |

No verb overlaps another. The thing `patchComponent` did — merge over the *existing* value — was the one redundant case, and it is now one obvious spread inside a recipe.

---

## The two moves, stated as one rule

> **Managed plain data in a store is deeply frozen. You change it by handing the world a new value — a partial to attach (`addComponent` / `setResource`), a function to transform (`updateComponent` / `updateResource`). Borrowed values (class instances, typed arrays, `Map`/`Set`/`Date`) are by reference, unfrozen, and outside the immutability and change-detection guarantee — change them by replacement; they are yours to manage.**

That single sentence replaces: clone-on-write, the dev-only freeze flag, the shallow-merge patch semantics, and three internal functions. Principle 2 becomes true *by construction for managed data*, with one explicit, enforceable boundary instead of a maintained-by-discipline proof.

---

## Public surface delta

**Removed**
- `CreateWorldOptions.freeze` (the dev deep-freeze boolean — freezing is now unconditional and structural)
- `World.patchComponent` (replaced by `updateComponent`)

**Added**
- `World.updateComponent(e, T, recipe)`
- `World.updateResource(T, recipe)`

**Net**: surface count flat; the win is the deletion of three internal clone functions (`clonePlainData`, `clonePartial`, `instantiateDefaults`'s clone loop), the `maybeFreeze`/`freezeEnabled` dev-gate, the dev/prod behavioral split, and the structural-sharing safety proofs in the write-path comments.

**Principle 2 rewrite** (README + docs):
> **One ownership rule** — *managed plain data* (arrays and `{}`-objects) crossing the API boundary is **frozen in place** and owned by the world: immutable by construction, **shared freely (never copied), replaced never mutated**. *Borrowed values* (class instances, typed arrays, `Map`/`Set`/`Date`) are by reference, unfrozen, and **outside** the immutability and change-detection guarantee — the caller's to manage, changed by replacement.

**Principle 3** is unaffected in wording but *strengthened* in fact for managed data: its "every value is a zero-copy reference to an immutable snapshot" clause is now enforced in all builds, not just dev. (For borrowed values the snapshot is a reference whose immutability the caller must uphold — the same caveat that already applies to any read.)

---

## Migration

Breaking, pre-1.0, shipped as one `feat!:` minor (`bump-minor-pre-major` is set): **v0.16 → v0.17**.

1. **`patchComponent` → `updateComponent`** (≈54 test sites; 8 README refs; `docs/api.html` + `docs/index.html`). Mechanical for the literal-partial case, codemod-able:
   ```ts
   world.patchComponent(e, Position, { x: 5 });
   // →
   world.updateComponent(e, Position, p => ({ ...p, x: 5 }));
   ```
   The compile error from the removed method *is* the migration guide (same doctrine as the v0.13 `setComponent`/`replaceComponent` removal). `applyChanges` already routes through `addComponent`, not `patchComponent` (`changes.ts:141-147`), so the blessed `/changes` layer needs no change.

2. **`createWorld({ freeze: true })` → `createWorld()`** (4 literal sites, in `define-freeze.test.ts`). Freezing is now unconditional; the option is removed. `createWorld({ freeze: false })` was the default *no-enforcement* mode — there is no longer an opt-out. **This is the one behavioral break to call out loudly**: any code that mutated a stored plain object in place (relying on clone-without-freeze tolerating it) now throws at the mutation. The fix is to go through a verb, or to make the value a class instance (borrowed). Surfacing this is the point.

3. **`define-freeze.test.ts`** broadens from "defaults are frozen at definition" to "stored values are frozen on every write" — the freeze is now the write path, not a definition-time-only assertion.

4. **New tests**: `updateComponent`/`updateResource` strictness (throws on dead/absent); the `Object.is` no-op skip (no event, no buffer entry, no run delta); **deep-freeze depth** (a nested plain object in a stored value is frozen, not just the top); **cyclic plain input throws a named error and leaves the caller's graph entirely un-frozen** (two-pass guarantee — validate before freeze); **a shared DAG is not a false cycle** (`{ a: shared, b: shared }` freezes cleanly); **shallow-pre-frozen input is still deep-frozen** (`Object.freeze({a:{b:1}})` → `a` is frozen after the write, the isFrozen-trust hole is closed); **a nested object behind a *symbol* key is frozen** and **a nested object behind a *non-enumerable* own data property is frozen** (own-key traversal, not `for...in`); **an accessor property in managed plain data throws a named error with nothing frozen**; **a `null`-prototype dictionary is treated as managed** (frozen); **a plain object inside a borrowed `Map` is *not* frozen** (the spine stops at borrowed boundaries); invasive-freeze (a nested plain object reachable from the store is frozen after the call); borrowed class instances and typed arrays left unfrozen and uncorrupted; **borrowed-bypass** (mutating a borrowed field in place and returning `prev` fires nothing — the documented §Scope behavior, asserted so it can't regress silently); **atomicity** (a write that throws on cyclic/accessor input, or whose recipe throws *without* a borrowed side effect, leaves the kernel state unchanged — prior stored reference in place, buffers empty, `changedResources` unmarked, no observer fired — asserted on `addComponent`, `updateComponent`, and `setResource`; and the companion: a recipe that mutates a borrowed field then throws is *not* rolled back, asserted so the §Atomicity boundary is explicit); **partial getter rejected** (`addComponent(e, T, { get x() {…} })` throws before the getter runs); **partial non-enumerable key ignored** (a non-enumerable own prop on the partial is not merged).

Downstream (`infinite-canvas`): the undo recipe built on RFC-006 retained diffs gets *safer* (immutability now guaranteed). The one thing to audit there is any code path that reads a component and mutates it in place — those were already bugs under the immutability rule and now throw instead of silently corrupting.

---

## Rejected alternatives

- **Per-component clone/freeze/equals policy** (design1's `component("T", { clone, freeze, equals })`). More powerful, more surface, and it scatters the ownership rule across every type definition. The class-instance boundary already serves the "manage it myself" case with zero new API. Rejected as over-engineering against the "one ownership rule" principle; revisit only if a concrete component needs a custom clone *and* cannot be a class instance.
- **A global `ownership: 'frozen' | 'borrowed'` world mode.** A mode is a second code path to test and a foot-gun (flip it and every safety property changes). Ownership is a property of the *data shape* (plain vs. class), not of the world; encoding it as the plain/class boundary keeps it local and unforgeable.
- **Keep `patchComponent` *and* add `updateComponent`.** Two verbs for "change a component," overlapping. The merge case is one spread inside the recipe; carrying a second verb to save five characters fails the clean-API goal.
- **Overload one verb on `value | recipe`** (React `setState` style). Tempting, but the partial-merges-over-defaults shape (`addComponent`) and the recipe-returns-full-T shape (`updateComponent`) have *different* semantics; collapsing them onto one name hides that difference and makes the types awkward (`Partial<T>` vs `(p) => T` when `T` is itself a function type). Two clearly-named verbs beat one magic one.
- **Immer `produce(draft => { draft.x++ })`.** The most ergonomic functional update, but a dependency and a Proxy cost, both against the dependency-free grain. `prev => ({ ...prev, x })` recovers ~90% of the ergonomics with zero deps and arguably clearer intent (the new shape is explicit). Reconsider only if the no-deps rule is ever relaxed.
- **Persistent collections (Immutable.js / HAMT).** Taxes the entire API with `.get()/.set()`, breaks plain-object serialization (snapshots, wire), and fights the React/UI audience. Frozen plain objects are the sweet spot: immutable enough to delete the defenses, plain enough to stay ergonomic and serializable.
- **`DeepReadonly<T>` on the recipe/read signatures.** Would catch `prev.nested.x = 1` at compile time, but it cannot distinguish *managed* nested data (should be deep-readonly) from *borrowed* fields (class instances/typed arrays, mutable by design) — it would wrongly freeze the borrowed ones at the type level — and it bloats inference and error messages. Shallow `Readonly<T>` + the runtime freeze is the honest pairing; the type is a hint, the freeze is the guarantee.

---

## Open questions

1. **`updateResource` no-op skip vs. lazy creation.** `setResource`/`onResourceChanged` lazily instantiate the resource from defaults on first touch (`world.ts:1606`). `updateResource` must instantiate-then-recipe on first touch; the `Object.is(prev, next)` skip then compares against the just-instantiated default. Specify: first-touch `updateResource` that returns the default unchanged is still a no-op (consistent), but the resource *store* is created (it exists henceforth) — instantiation is not a change, mirroring `getResource`. Low risk; call it out in the resource section of the impl.
2. **Should `addComponent` gain an `Object.is` skip on re-attach?** No — `addComponent` rebuilds from defaults+partial, always a fresh object, and a replace is a legitimate event consumers want. Skip stays a property of the *transform* verbs only.
3. **Cycle guard: decided — adopt the two-pass DFS.** Validate/collect (three-colour: per-call `visiting` + `done`) then freeze, so cyclic input throws with nothing frozen and a shared DAG is not a false positive (in-spec above). The remaining open part is the *optional provenance `WeakSet`* (`frozenPlain`, completed nodes only) that would make the walk `O(changed)` — a *separate* structure from the cycle guard, not a replacement for it: ship it now, or defer until a deep-component workload justifies the per-object weak entry? Lean **defer** — the two-pass spec is correct and cheap for shallow UI components; add the `WeakSet` only against a profile.
4. **Naming: `updateComponent` vs `update`.** The library spells verbs in full (`addComponent`, `removeComponent`). `updateComponent` matches. Confirmed, but noted in case the shorter form is preferred at the 1.0 surface freeze.
5. **"Managed plain data" shape: decided.** (a) Predicate is the **prototype** test (`Object.getPrototypeOf(v) ∈ {Object.prototype, null}` or array), not `constructor === Object` — forgery-resistant; `null`-proto dictionaries are managed. (b) Traversal is **own keys** (`Reflect.ownKeys`, string + symbol, enumerable + non-enumerable) over **data properties**; (c) **accessor properties throw** in the validate pass (a getter's result can't be guaranteed immutable, and invoking it would be a write-path side effect) — chosen over silently skipping (a guarantee hole) or descending into getter results (unsound); (d) **`Proxy`/exotic objects masquerading as plain are unsupported** — undetectable by inspection, so documented as undefined behavior alongside cyclic input, not papered over. Open only if a real consumer needs symbol-free serialization strictness or accessor-bearing component values — neither is on the horizon.

---

## Staging

One release, no phasing — the moves are coupled (the recipe's `prev` is only truly immutable once Move 1 lands) and the blast radius is a single mechanical rename plus one option removal.

- **v0.17.0 (`feat!:`)**: `freezePlain` (two-pass: three-colour validate/collect over `Reflect.ownKeys`/descriptors, then freeze) as the unconditional write-path ownership op; descriptor-aware partial merge (no bare spread — getters rejected pre-merge); **reorder every write verb so construction+freeze precede all change-tracking (atomicity)**; delete `clonePlainData`/`clonePartial`/clone-loop/`maybeFreeze`/`freezeEnabled`/`CreateWorldOptions.freeze`; `updateComponent` replaces `patchComponent`; add `updateResource`; `Object.is` no-op skip on both transform verbs; scope the guarantee to managed plain data; migrate test + README + HTML doc sites; rewrite Principle 2.

---

## The one-line summary

> The world holds frozen plain data. To change it, hand the world a new value — a partial to attach, a function to transform. No defensive deep clone is made, managed values can't be mutated, and the immutability the change journal already depends on is now true by construction for managed data — with one explicit boundary (borrowed values are yours) instead of a proof maintained by discipline.
