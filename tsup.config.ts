import { defineConfig } from "tsup"

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	target: "ES2020",
	splitting: false,
	sourcemap: true,
	dts: true,
	clean: true,
	minify: false,
	treeshake: true,
	skipNodeModulesBundle: true,
	outDir: "dist",
})
