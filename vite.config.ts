import { defineConfig } from "vite";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bake the deploy identity into the bundle so we can verify what's
// live ("use version abc1234" when debugging). Vercel sets
// VERCEL_GIT_COMMIT_SHA in build env; locally we shell out to git.
function getBuildSha(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  }
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim() || "dev";
  } catch {
    return "dev";
  }
}
const BUILD_SHA = getBuildSha();
const BUILD_TIME = new Date().toISOString();

// On the public Vercel deploy we ship only the landing. The studio app uses
// VITE_GEMINI_API_KEY which would be inlined into the client bundle — fine
// for local dev, never for prod.
const landingOnly = process.env.VITE_LANDING_ONLY === "1";

// Mirror the Vercel rewrite (`/` → `/landing.html`) in dev so the local
// experience matches prod and `localhost:5173/?g=…` resolves the landing
// page rather than the legacy studio app.
const rewriteRootToLanding = {
  name: "rewrite-root-to-landing",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/" || req.url?.startsWith("/?")) {
        req.url = "/landing.html" + (req.url === "/" ? "" : req.url.slice(1));
      }
      next();
    });
  },
};

export default defineConfig({
  server: { port: 5173 },
  plugins: [rewriteRootToLanding],
  define: {
    __PRISM_BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __PRISM_BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  build: {
    rollupOptions: {
      input: landingOnly
        ? {
            landing: resolve(__dirname, "landing.html"),
            gallery: resolve(__dirname, "gallery.html"),
            embed: resolve(__dirname, "examples/embed.html"),
          }
        : {
            studio: resolve(__dirname, "index.html"),
            landing: resolve(__dirname, "landing.html"),
            gallery: resolve(__dirname, "gallery.html"),
            embed: resolve(__dirname, "examples/embed.html"),
          },
    },
  },
});
