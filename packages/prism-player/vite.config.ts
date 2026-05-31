import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

// Library build for prism-player.
// Emits ESM + CJS + .d.ts. Browser-only — uses Web Audio + WebGL2.
// Peer-dep packages (butterchurn family) are externalised so the
// consumer installs whichever versions they want and Milkdrop pulls in
// no bytes for shader-only embeds.
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
      fileName: (format) => `prism-player.${format === "es" ? "mjs" : "cjs"}`,
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
