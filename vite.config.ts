import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// On the public Vercel deploy we ship only the landing. The studio app uses
// VITE_GEMINI_API_KEY which would be inlined into the client bundle — fine
// for local dev, never for prod.
const landingOnly = process.env.VITE_LANDING_ONLY === "1";

export default defineConfig({
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: landingOnly
        ? {
            landing: resolve(__dirname, "landing.html"),
            gallery: resolve(__dirname, "gallery.html"),
          }
        : {
            studio: resolve(__dirname, "index.html"),
            landing: resolve(__dirname, "landing.html"),
            gallery: resolve(__dirname, "gallery.html"),
          },
    },
  },
});
