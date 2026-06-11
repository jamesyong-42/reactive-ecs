import { describe, expect, it } from 'vitest';
import { defineComponent, defineResource } from '../define.js';
import { createWorld } from '../world.js';

describe('defaults are frozen at definition (ownership rule)', () => {
	it('mutating component defaults throws in strict mode', () => {
		const Pos = defineComponent('FrozenPos', { nested: { x: 0 }, list: [1] });
		expect(() => {
			(Pos.defaults.nested as { x: number }).x = 99;
		}).toThrow(TypeError);
		expect(() => {
			(Pos.defaults.list as number[]).push(2);
		}).toThrow(TypeError);
	});

	it('mutating resource defaults throws in strict mode', () => {
		const Cfg = defineResource('FrozenCfg', { opts: { dark: false } });
		expect(() => {
			(Cfg.defaults.opts as { dark: boolean }).dark = true;
		}).toThrow(TypeError);
	});

	it('frozen defaults still attach and patch normally (per-attach clone)', () => {
		const Pos = defineComponent('FrozenPos2', { nested: { x: 0 } });
		const world = createWorld();
		const e = world.createEntity();
		world.addComponent(e, Pos);
		world.patchComponent(e, Pos, { nested: { x: 5 } });
		expect(world.getComponent(e, Pos)).toEqual({ nested: { x: 5 } });
	});

	it('class instances in defaults are not frozen', () => {
		class Index {
			n = 0;
		}
		const Res = defineResource('FrozenRes', { idx: new Index() });
		expect(() => {
			(Res.defaults.idx as Index).n = 1;
		}).not.toThrow();
	});
});
