// The describer seam — the ONE place identity is read off composition (matching the ECS
// principle: what an entity IS emerges from which components/tags it carries). Both the
// inspector's entity list and the timeline render from the same describer, so labels,
// colours, and outcomes stay single-sourced. Consumers pass their own `EntityDescriber`
// to brand entities with domain labels/colours; the default needs zero configuration.

import type { EntityId, World } from '../types.js';

/** Fallback bar/swatch colour when a descriptor doesn't specify one. */
export const DEFAULT_DESCRIPTOR_COLOR = '#768390';

export interface EntityDescriptor {
	/** Human label for the timeline gutter + entity list row. */
	label: string;
	/** Bar/swatch colour; defaults to {@link DEFAULT_DESCRIPTOR_COLOR}. */
	color?: string;
	/** Shown after the label (e.g. a state-machine phase); frozen at death. */
	detail?: string | null;
	/** Timeline end-cap: 'win' draws green, 'lose' draws red; null/undefined = no cap. */
	outcome?: 'win' | 'lose' | null;
}

/** Reads an entity's identity off its composition. */
export type EntityDescriber = (world: World, e: EntityId) => EntityDescriptor;

/**
 * Zero-config describer: label = the first component's name, else the first tag's name,
 * else `entity`; detail = the remaining tag names joined with `·`, or null. No colour or
 * outcome overrides — pass your own describer for those.
 */
export function defaultDescriber(world: World, e: EntityId): EntityDescriptor {
	const comps = world.getComponentsOf(e);
	const tags = world.getTagsOf(e);
	if (comps.length > 0) {
		return {
			label: comps[0].name,
			detail: tags.length > 0 ? tags.map((t) => t.name).join('·') : null,
		};
	}
	if (tags.length > 0) {
		return {
			label: tags[0].name,
			detail:
				tags.length > 1
					? tags
							.slice(1)
							.map((t) => t.name)
							.join('·')
					: null,
		};
	}
	return { label: 'entity', detail: null };
}
