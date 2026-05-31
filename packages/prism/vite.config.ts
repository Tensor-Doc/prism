import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

// Library build for @tensordoc/prism.
// Emits ESM + CJS + .d.ts. Browser-only — uses Web Audio + WebGL2.
// butterchurn family is bundled (regular deps, not peer) so `npm
// install @tensordoc/prism` gives consumers a working Milkdrop player
// without a second install step.
export default defineConfig({
  plugins: [
    dts({
      entryRoot: "src",
      include: ["src/**/*.ts"],
      outDir: "dist",
      insertTypesEntry: true,
    }),
  ],
  build: {
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es", "cjs"],
      fileName: (format) => `prism.${format === "es" ? "mjs" : "cjs"}`,
    },
    rollupOptions: {
      external: [
        "butterchurn",
        "butterchurn-presets",
        "milkdrop-preset-converter",
      ],
    },
  },
});
