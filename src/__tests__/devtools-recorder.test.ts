import { describe, expect, it } from 'vitest';
import { defineComponent, defineTag } from '../define.js';
import {
	createLifecycleRecorder,
	defaultDescriber,
	type EntityDescriber,
} from '../devtools/index.js';
import { createWorld } from '../world.js';

const Name = defineComponent('Name', { value: '' });
const Position = defineComponent('Position', { x: 0, y: 0 });
const Selected = defineTag('Selected');
const Visible = defineTag('Visible');

describe('createLifecycleRecorder', () => {
	it('records birth tick and ms via the injected clock', () => {
		const world = createWorld();
		let ms = 0;
		const recorder = createLifecycleRecorder(world, { now: () => ms });
		world.incrementTick();
		world.incrementTick();
		ms = 125;
		const e = world.createEntity();
		const recs = recorder.records();
		expect(recs).toHaveLength(1);
		expect(recs[0].id).toBe(e);
		expect(recs[0].bornTick).toBe(2);
		expect(recs[0].bornMs).toBe(125);
		expect(recs[0].diedTick).toBeNull();
		expect(recs[0].diedMs).toBeNull();
		expect(recs[0].descriptor).toBeNull(); // alive — identity is read live via a describer
	});

	it('freezes the descriptor at death while components are still readable', () => {
		// Regression-locks destroyEntity's listeners-before-teardown ordering: the describer
		// runs inside onEntityDestroyed and must still see the dying entity's components.
		const world = createWorld();
		const describer: EntityDescriber = (w, e) => {
			const name = w.getComponent(e, Name);
			return { label: name ? name.value : 'unreadable', detail: null };
		};
		const recorder = createLifecycleRecorder(world, { describer });
		const e = world.createEntity();
		world.addComponent(e, Name, { value: 'hero' });
		world.destroyEntity(e);
		const rec = recorder.records()[0];
		expect(rec.diedTick).toBe(world.currentTick);
		expect(rec.descriptor).not.toBeNull();
		expect(rec.descriptor?.label).toBe('hero'); // came from component data, post-destroy call
	});

	it('captures 1-tick entities created and destroyed within the same tick', () => {
		const world = createWorld();
		const recorder = createLifecycleRecorder(world, { now: () => 0 });
		const e = world.createEntity();
		world.destroyEntity(e); // same tick — a poll-based observer would never see this
		const recs = recorder.records();
		expect(recs).toHaveLength(1);
		expect(recs[0].bornTick).toBe(recs[0].diedTick);
		expect(recs[0].descriptor).not.toBeNull();
	});

	it('evicts the oldest DEAD records at cap, never a living entity', () => {
		const world = createWorld();
		const recorder = createLifecycleRecorder(world, { cap: 3, now: () => 0 });
		const living = world.createEntity();
		const dead1 = world.createEntity();
		const dead2 = world.createEntity();
		world.destroyEntity(dead1);
		world.destroyEntity(dead2);
		world.createEntity(); // 4th record — exceeds cap, evicts oldest dead (dead1)
		const ids = recorder.records().map((r) => r.id);
		expect(ids).toHaveLength(3);
		expect(ids).toContain(living);
		expect(ids).toContain(dead2);
		expect(ids).not.toContain(dead1);
	});

	it('clear() drops dead records but keeps living entities with their true birth', () => {
		const world = createWorld();
		let ms = 0;
		const recorder = createLifecycleRecorder(world, { now: () => ms });
		ms = 10;
		const living = world.createEntity();
		ms = 20;
		const dead = world.createEntity();
		world.destroyEntity(dead);
		recorder.clear();
		const recs = recorder.records();
		expect(recs).toHaveLength(1);
		expect(recs[0].id).toBe(living);
		expect(recs[0].bornMs).toBe(10); // birth preserved, not re-based
	});

	it('dispose() stops recording', () => {
		const world = createWorld();
		const recorder = createLifecycleRecorder(world, { now: () => 0 });
		const e = world.createEntity();
		recorder.dispose();
		world.createEntity();
		world.destroyEntity(e);
		const recs = recorder.records();
		expect(recs).toHaveLength(1);
		expect(recs[0].diedMs).toBeNull(); // the destroy after dispose() wasn't seen
	});

	it('keeps records in birth order', () => {
		const world = createWorld();
		const recorder = createLifecycleRecorder(world, { now: () => 0 });
		const a = world.createEntity();
		const b = world.createEntity();
		const c = world.createEntity();
		world.destroyEntity(b); // death does not reorder
		expect(recorder.records().map((r) => r.id)).toEqual([a, b, c]);
	});
});

describe('defaultDescriber', () => {
	it('labels by first component name, with tags as detail', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Name, { value: 'x' });
		world.addComponent(e, Position, { x: 0, y: 0 });
		world.addTag(e, Selected);
		world.addTag(e, Visible);
		const d = defaultDescriber(world, e);
		expect(d.label).toBe('Name');
		expect(d.detail).toBe('Selected·Visible');
	});

	it('falls back to first tag name when there are no components', () => {
		const world = createWorld();
		const e = world.createEntity();
		world.addTag(e, Selected);
		world.addTag(e, Visible);
		const d = defaultDescriber(world, e);
		expect(d.label).toBe('Selected');
		expect(d.detail).toBe('Visible');
	});

	it("falls back to 'entity' for bare entities", () => {
		const world = createWorld();
		const e = world.createEntity();
		const d = defaultDescriber(world, e);
		expect(d.label).toBe('entity');
		expect(d.detail).toBeNull();
		expect(d.color).toBeUndefined();
		expect(d.outcome).toBeUndefined();
	});
});
