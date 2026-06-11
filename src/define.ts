import type {
	ComponentType,
	NotTerm,
	RelationOptions,
	RelationType,
	ResourceType,
	SystemDef,
	TagType,
} from './types.js';

/**
 * Deep-freeze plain data — arrays and objects whose constructor is `Object`,
 * recursively; class instances (and anything else) are left alone. Applied to
 * `defaults` unconditionally: defaults are templates cloned per-attach, so a
 * post-definition mutation would silently change every future attach. Same
 * plain-data boundary as the world's clone (ownership rule).
 */
function freezePlainData(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) freezePlainData(item);
		Object.freeze(value);
	} else if (value !== null && typeof value === 'object' && value.constructor === Object) {
		for (const key in value) freezePlainData((value as Record<string, unknown>)[key]);
		Object.freeze(value);
	}
}

/**
 * Defines a new ECS component type with a name and default values.
 * Components hold structured data attached to entities.
 */
export function defineComponent<T extends Record<string, unknown>>(
	name: string,
	defaults: T,
): ComponentType<T> {
	freezePlainData(defaults);
	return Object.freeze({ name, defaults, __kind: 'component' as const });
}

/**
 * Defines a new ECS tag type (boolean marker with no data).
 * Tags are lightweight flags for entity state like Selected or Visible.
 */
export function defineTag(name: string): TagType {
	return Object.freeze({ name, __kind: 'tag' as const });
}

/**
 * Wraps a component or tag type as a negated query term.
 * `world.query(A, Not(B))` matches entities that have A and do NOT have B.
 */
export function Not(type: ComponentType | TagType): NotTerm {
	return Object.freeze({ type, __kind: 'not' as const });
}

/**
 * Defines a new ECS relation type — a managed, inverse-indexed edge between
 * two entities. The world maintains the target→sources inverse automatically
 * and guarantees no edge survives the destruction of either endpoint.
 */
export function defineRelation(name: string, opts?: RelationOptions): RelationType {
	return Object.freeze({
		name,
		options: Object.freeze({
			sourceExclusive: opts?.sourceExclusive ?? false,
			targetExclusive: opts?.targetExclusive ?? false,
			onTargetDestroy: opts?.onTargetDestroy ?? ('clear' as const),
		}),
		__kind: 'relation' as const,
	});
}

/**
 * Defines a new ECS resource type (singleton data shared across all systems).
 * Resources hold global state like camera position, viewport size, and configuration.
 */
export function defineResource<T extends Record<string, unknown>>(
	name: string,
	defaults: T,
): ResourceType<T> {
	freezePlainData(defaults);
	return Object.freeze({ name, defaults, __kind: 'resource' as const });
}

/**
 * Defines a new ECS system with execution order constraints (before/after).
 * Systems are named functions that query and transform ECS data each tick.
 */
export function defineSystem(def: SystemDef): SystemDef {
	return def;
}
