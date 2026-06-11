import type { SystemDef, World } from './types.js';

/**
 * Optional hook for instrumenting system execution — e.g. performance profiling.
 * Any object implementing `beginSystem` / `endSystem` can be attached to a
 * scheduler. `beginPhase` / `endPhase` are consumed only by `PhasedScheduler`
 * and are optional, so existing profilers remain compatible.
 */
export interface SystemProfiler {
	beginSystem(name: string): void;
	endSystem(name: string): void;
	beginPhase?(phase: string): void;
	endPhase?(phase: string): void;
	/**
	 * Called when a system's `runIf` returned false this tick. On a skip,
	 * `beginSystem` / `endSystem` are not called — only this hook.
	 */
	skipSystem?(name: string): void;
}

/**
 * Module-private: per-phase buckets created by PhasedScheduler, where a
 * constraint may legally point at a system in another phase. These buckets
 * skip unknown-target validation (PhasedScheduler validates against its full
 * registry instead). Not expressible from outside this module — consumers
 * cannot disable the validation.
 */
const tolerantBuckets = new WeakSet<SystemScheduler>();

/**
 * Manages system registration and ordered execution.
 * Systems declare after/before constraints and are topologically sorted.
 */
export class SystemScheduler {
	private systems: SystemDef[] = [];
	private sorted: SystemDef[] | null = null;
	profiler: SystemProfiler | null = null;

	register(system: SystemDef) {
		// Replace if system with same name exists
		this.systems = this.systems.filter((s) => s.name !== system.name);
		this.systems.push(system);
		this.sorted = null; // invalidate sort
	}

	remove(name: string) {
		this.systems = this.systems.filter((s) => s.name !== name);
		this.sorted = null;
	}

	/** Number of systems currently registered. */
	get size(): number {
		return this.systems.length;
	}

	/**
	 * Execute all systems in dependency order.
	 */
	execute(world: World) {
		if (!this.sorted) {
			this.sorted = this.topoSort();
		}
		const p = this.profiler;
		for (const system of this.sorted) {
			if (system.runIf && !system.runIf(world)) {
				if (p) p.skipSystem?.(system.name);
				continue;
			}
			if (p) p.beginSystem(system.name);
			system.execute(world);
			if (p) p.endSystem(system.name);
		}
	}

	getSystemNames(): string[] {
		if (!this.sorted) {
			this.sorted = this.topoSort();
		}
		return this.sorted.map((s) => s.name);
	}

	/**
	 * Topological sort based on after/before constraints.
	 * Falls back to registration order for unconstrained systems.
	 *
	 * Validation is deferred to here — first execute() / getSystemNames()
	 * after any register/remove — so systems can be registered in any order.
	 * A constraint naming an unregistered system throws: silent tolerance
	 * would let a typo quietly reorder the pipeline.
	 */
	private topoSort(): SystemDef[] {
		const byName = new Map<string, SystemDef>();
		for (const s of this.systems) {
			byName.set(s.name, s);
		}

		if (!tolerantBuckets.has(this)) {
			for (const s of this.systems) {
				for (const kind of ['after', 'before'] as const) {
					const value = s[kind];
					const deps = Array.isArray(value) ? value : value ? [value] : [];
					for (const dep of deps) {
						if (!byName.has(dep)) {
							throw new Error(
								`System '${s.name}' declares ${kind}: '${dep}', but no system named '${dep}' is registered.`,
							);
						}
					}
				}
			}
		}

		// Build adjacency list: edges[a] = [b] means a must run before b
		const edges = new Map<string, Set<string>>();
		const inDegree = new Map<string, number>();

		for (const s of this.systems) {
			if (!edges.has(s.name)) edges.set(s.name, new Set());
			if (!inDegree.has(s.name)) inDegree.set(s.name, 0);
		}

		for (const s of this.systems) {
			const afters = Array.isArray(s.after) ? s.after : s.after ? [s.after] : [];
			for (const dep of afters) {
				// dep must run before s
				if (!byName.has(dep)) continue;
				if (!edges.has(dep)) edges.set(dep, new Set());
				const depEdges = edges.get(dep);
				// Only increment inDegree when the edge is actually new. Duplicate
				// dependency references (e.g. after: ['a', 'a']) must not double-count
				// or we'll over-count and report a false cycle.
				if (depEdges && !depEdges.has(s.name)) {
					depEdges.add(s.name);
					inDegree.set(s.name, (inDegree.get(s.name) || 0) + 1);
				}
			}

			const befores = Array.isArray(s.before) ? s.before : s.before ? [s.before] : [];
			for (const dep of befores) {
				// s must run before dep
				if (!byName.has(dep)) continue;
				if (!edges.has(s.name)) edges.set(s.name, new Set());
				const systemEdges = edges.get(s.name);
				if (systemEdges && !systemEdges.has(dep)) {
					systemEdges.add(dep);
					inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
				}
			}
		}

		// Kahn's algorithm — stable sort (preserves registration order for ties)
		const queue: string[] = [];
		const registrationOrder = new Map<string, number>();
		for (let i = 0; i < this.systems.length; i++) {
			registrationOrder.set(this.systems[i].name, i);
		}

		for (const s of this.systems) {
			if ((inDegree.get(s.name) || 0) === 0) {
				queue.push(s.name);
			}
		}
		// Sort queue by registration order for stability
		queue.sort((a, b) => (registrationOrder.get(a) || 0) - (registrationOrder.get(b) || 0));

		const result: SystemDef[] = [];
		while (queue.length > 0) {
			const name = queue.shift();
			if (!name) continue;
			const system = byName.get(name);
			if (system) result.push(system);

			const neighbors = edges.get(name) || new Set();
			const newReady: string[] = [];
			for (const neighbor of neighbors) {
				const deg = (inDegree.get(neighbor) || 0) - 1;
				inDegree.set(neighbor, deg);
				if (deg === 0) {
					newReady.push(neighbor);
				}
			}
			// Sort newly ready by registration order
			newReady.sort((a, b) => (registrationOrder.get(a) || 0) - (registrationOrder.get(b) || 0));
			queue.push(...newReady);
		}

		if (result.length !== this.systems.length) {
			const missing = this.systems
				.filter((s) => !result.find((r) => r.name === s.name))
				.map((s) => s.name);
			throw new Error(`Circular system dependency detected involving: ${missing.join(', ')}`);
		}

		return result;
	}
}

/**
 * Configuration passed to `new PhasedScheduler({ ... })`.
 *
 * @template P - String literal union of phase names. Use `as const` on the
 *   `phases` array literal to get type-narrowed phase strings everywhere
 *   (e.g. `getPhase()` return, profiler hook arguments, error messages).
 */
export interface PhasedSchedulerOptions<P extends string> {
	/**
	 * Phase order. Earlier phases run first each tick. Must be non-empty and
	 * contain no duplicates.
	 */
	readonly phases: readonly P[];
	/**
	 * Phase used when a system is registered without an explicit `phase`. If
	 * unset, registering an unstamped system throws — phase membership is then
	 * mandatory at the call site.
	 */
	readonly defaultPhase?: P;
}

/**
 * Bucketed scheduler that runs systems in a caller-defined phase order.
 *
 * The library ships zero phase opinions — phase names and their order are
 * passed in by the consumer. Within a phase, `after` / `before` constraints
 * continue to topologically sort (delegated to a per-phase `SystemScheduler`).
 * Cross-phase ordering is implicit in phase order; cross-phase `after` /
 * `before` constraints are rejected at first `execute()` to keep ordering
 * single-sourced.
 *
 * Phase membership is validated at register time. `SystemDef.phase` is
 * compared against the configured `phases` array; an unknown phase throws.
 *
 * Profiler hooks: if `profiler.beginPhase` / `endPhase` are present, they
 * bracket each non-empty phase. `beginSystem` / `endSystem` continue to
 * bracket each system as in `SystemScheduler`.
 *
 * @example
 *   const scheduler = new PhasedScheduler({
 *     phases: ['ingest', 'react', 'control', 'apply', 'cleanup'] as const,
 *     defaultPhase: 'control',
 *   });
 *   scheduler.register(defineSystem({ name: 'sync', phase: 'ingest', execute: ... }));
 *   scheduler.execute(world);
 */
export class PhasedScheduler<P extends string = string> {
	private readonly phases: readonly P[];
	private readonly phaseToIndex: Map<P, number>;
	private readonly defaultPhase: P | undefined;
	private buckets = new Map<P, SystemScheduler>();
	private entries = new Map<string, { phase: P; system: SystemDef }>();
	private validated = false;
	profiler: SystemProfiler | null = null;

	constructor(options: PhasedSchedulerOptions<P>) {
		if (options.phases.length === 0) {
			throw new Error('PhasedScheduler: `phases` must contain at least one phase.');
		}
		const seen = new Set<P>();
		for (const phase of options.phases) {
			if (seen.has(phase)) {
				throw new Error(`PhasedScheduler: duplicate phase '${phase}' in phases list.`);
			}
			seen.add(phase);
		}
		if (options.defaultPhase !== undefined && !seen.has(options.defaultPhase)) {
			throw new Error(
				`PhasedScheduler: defaultPhase '${options.defaultPhase}' is not in phases ${JSON.stringify(options.phases)}.`,
			);
		}
		this.phases = options.phases;
		this.phaseToIndex = new Map(options.phases.map((p, i) => [p, i]));
		this.defaultPhase = options.defaultPhase;
	}

	register(system: SystemDef) {
		const explicit = system.phase as P | undefined;
		const phase = explicit ?? this.defaultPhase;
		if (phase === undefined) {
			throw new Error(
				`PhasedScheduler: system '${system.name}' has no \`phase\` and no defaultPhase is configured. ` +
					`Set \`phase\` on the system or pass \`defaultPhase\` to the scheduler.`,
			);
		}
		if (!this.phaseToIndex.has(phase)) {
			throw new Error(
				`PhasedScheduler: system '${system.name}' uses phase '${phase}', which is not in configured phases ${JSON.stringify(this.phases)}.`,
			);
		}

		const prev = this.entries.get(system.name);
		// Re-registering the same name into a different phase moves the system —
		// remove from the old bucket so it doesn't run twice.
		if (prev && prev.phase !== phase) {
			this.buckets.get(prev.phase)?.remove(system.name);
		}
		let bucket = this.buckets.get(phase);
		if (!bucket) {
			bucket = new SystemScheduler();
			// Constraints may legally point at systems in other phases — the
			// bucket can't see them, so unknown-target validation happens here
			// in ensureValidated() against the full registry instead.
			tolerantBuckets.add(bucket);
			this.buckets.set(phase, bucket);
		}
		bucket.register(system);
		this.entries.set(system.name, { phase, system });
		this.validated = false;
	}

	remove(name: string) {
		const entry = this.entries.get(name);
		if (!entry) return;
		this.buckets.get(entry.phase)?.remove(name);
		this.entries.delete(name);
		this.validated = false;
	}

	/** Phase the system is registered in, or `undefined` if not registered. */
	getPhase(name: string): P | undefined {
		return this.entries.get(name)?.phase;
	}

	/** Configured phase order (read-only view of the constructor input). */
	getPhases(): readonly P[] {
		return this.phases;
	}

	/**
	 * Names of all registered systems, ordered by phase then by within-phase
	 * topological sort. Triggers cross-phase validation and within-phase topo
	 * sort; throws if either fails.
	 */
	getSystemNames(): string[] {
		this.ensureValidated();
		const names: string[] = [];
		for (const phase of this.phases) {
			const bucket = this.buckets.get(phase);
			if (!bucket || bucket.size === 0) continue;
			names.push(...bucket.getSystemNames());
		}
		return names;
	}

	/**
	 * Execute all systems for one tick, phase by phase. Cross-phase constraints
	 * are validated lazily on first call (and after every register/remove);
	 * within-phase ordering uses the existing `SystemScheduler` topo sort.
	 */
	execute(world: World) {
		this.ensureValidated();
		for (const phase of this.phases) {
			const bucket = this.buckets.get(phase);
			if (!bucket || bucket.size === 0) continue;
			// Forward the current profiler each tick so profiler swaps after
			// register-time still take effect on the next execute().
			bucket.profiler = this.profiler;
			this.profiler?.beginPhase?.(phase);
			bucket.execute(world);
			this.profiler?.endPhase?.(phase);
		}
	}

	private ensureValidated() {
		if (this.validated) return;
		for (const [name, entry] of this.entries) {
			const sIdx = this.phaseToIndex.get(entry.phase) ?? -1;
			const { after, before } = entry.system;
			const afters = Array.isArray(after) ? after : after ? [after] : [];
			for (const dep of afters) {
				const depEntry = this.entries.get(dep);
				if (!depEntry) {
					throw new Error(
						`System '${name}' declares after: '${dep}', but no system named '${dep}' is registered.`,
					);
				}
				const dIdx = this.phaseToIndex.get(depEntry.phase) ?? -1;
				if (dIdx > sIdx) {
					throw new Error(
						`System '${name}' (phase '${entry.phase}') declares after='${dep}', but '${dep}' is in later phase '${depEntry.phase}'. ` +
							`Cross-phase 'after' must reference the same or an earlier phase. Either drop the constraint (the dependency would only ever satisfy if you moved '${name}' into a later phase), or move '${name}' into a phase at or after '${depEntry.phase}'.`,
					);
				}
			}
			const befores = Array.isArray(before) ? before : before ? [before] : [];
			for (const dep of befores) {
				const depEntry = this.entries.get(dep);
				if (!depEntry) {
					throw new Error(
						`System '${name}' declares before: '${dep}', but no system named '${dep}' is registered.`,
					);
				}
				const dIdx = this.phaseToIndex.get(depEntry.phase) ?? -1;
				if (dIdx < sIdx) {
					throw new Error(
						`System '${name}' (phase '${entry.phase}') declares before='${dep}', but '${dep}' is in earlier phase '${depEntry.phase}'. ` +
							`Cross-phase 'before' must reference the same or a later phase. Either remove the constraint, or move '${name}' into a phase at or before '${depEntry.phase}'.`,
					);
				}
			}
		}
		this.validated = true;
	}
}
