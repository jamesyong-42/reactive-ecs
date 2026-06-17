import { defineConfig } from 'tsup';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/react/index.ts',
		'src/devtools/index.ts',
		'src/devtools/react/index.ts',
	],
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
});
