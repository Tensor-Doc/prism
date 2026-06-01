// iterate-shader — one round of GLSL generation, atlas generation,
// headless render, and capture.
//
//   pnpm prism iterate-shader <concept-id> [--iteration N]
//
// What it does.
//
//   1. Reads concepts/shaders.json for the named concept.
//   2. Reads concepts/prompts/<concept-id>.md for the prompt brief.
//   3. Reads skills/glsl-writer/SKILL.md for shader conventions.
//   4. Reads concepts/iterations/<concept-id>/iter-<N-1>/critique.md
//      if it exists. Appends to the prompt as a refinement note.
//   5. Generates an image atlas via Nano Banana. Uses the concept's
//      default_image_prompt to make 16 individual tiles, then composes
//      them as a single 2048x2048 grid PNG.
//   6. Calls Gemini 2.5 Pro with the GLSL Writer skill + the concept
//      prompt. Returns a .glsl source.
//   7. Spawns headless Chrome, loads the shadertoy capture page with
//      the new shader and atlas. Captures 10 seconds of webm.
//   8. Writes the entire iteration to disk under
//      concepts/iterations/<concept-id>/iter-NNN/.
//
// The script does not annotate or commit. Those are separate steps
// for after the prompt+skill combo is producing excellent shaders.

import { GoogleGenAI } from "@google/genai";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Concept {
  id: string;
  name: string;
  description: string;
  inputs: string[];
  default_image_prompt?: string;
}

interface ShaderConcepts {
  concepts: Concept[];
}

const REPO_ROOT = process.cwd();
const CONCEPTS_PATH = join(REPO_ROOT, "concepts/shaders.json");
const SKILL_PATH = join(REPO_ROOT, "skills/glsl-writer/SKILL.md");
const PROMPTS_DIR = join(REPO_ROOT, "concepts/prompts");
const ITERATIONS_DIR = join(REPO_ROOT, "concepts/iterations");

const ATLAS_TILES_PER_ROW = 4; // 4x4 grid = 16 tiles
const TILE_SIZE = 512;          // each tile is 512x512
const ATLAS_SIZE = ATLAS_TILES_PER_ROW * TILE_SIZE; // 2048x2048 final atlas

const CAPTURE_DURATION_MS = 10_000;

// gemini-flash-latest is what api/generate.ts already uses successfully.
// gemini-2.5-pro and gemini-3.x-preview 404 against the user's API key
// because those models gate by account; flash-latest is universally
// available and produces good GLSL.
const MODEL_TEXT = "gemini-flash-latest";
const MODEL_IMAGE = "gemini-3.1-flash-image-preview";

export async function runIterateShader(repoRoot: string, args: string[]): Promise<void> {
  const conceptId = args.find((a) => !a.startsWith("--"));
  if (!conceptId) throw new Error("usage: pnpm prism iterate-shader <concept-id>");

  const iterArg = args.find((a) => a.startsWith("--iteration="));
  const iterOverride = iterArg ? Number(iterArg.split("=")[1]) : null;

  // ── Load inputs ─────────────────────────────────────────
  const concepts: ShaderConcepts = JSON.parse(readFileSync(CONCEPTS_PATH, "utf8"));
  const concept = concepts.concepts.find((c) => c.id === conceptId);
  if (!concept) throw new Error(`unknown concept: ${conceptId}`);

  const skillContent = readFileSync(SKILL_PATH, "utf8");
  const promptPath = join(PROMPTS_DIR, `${conceptId}.md`);
  if (!existsSync(promptPath)) {
    throw new Error(`no prompt file at ${promptPath}. Write one based on concepts/prompts/refik-fluid-flora.md`);
  }
  const conceptPrompt = readFileSync(promptPath, "utf8");

  // ── Determine iteration number ──────────────────────────
  const conceptIterDir = join(ITERATIONS_DIR, conceptId);
  mkdirSync(conceptIterDir, { recursive: true });
  const existingIters = readdirSync(conceptIterDir)
    .filter((d) => d.startsWith("iter-"))
    .map((d) => Number(d.replace("iter-", "")))
    .filter((n) => Number.isFinite(n));
  const nextIter = iterOverride ?? (existingIters.length > 0 ? Math.max(...existingIters) + 1 : 1);
  const iterDir = join(conceptIterDir, `iter-${String(nextIter).padStart(3, "0")}`);
  mkdirSync(iterDir, { recursive: true });
  console.log(`[iterate-shader] ${conceptId} iteration ${nextIter} → ${iterDir}`);

  // ── Read prior critique + shader if present ────────────
  // Pass both so the model can apply targeted edits instead of
  // regenerating the whole shader and oscillating between extremes.
  let priorCritique: string | null = null;
  let priorShader: string | null = null;
  if (nextIter > 1) {
    const prevDir = join(conceptIterDir, `iter-${String(nextIter - 1).padStart(3, "0")}`);
    const critiquePath = join(prevDir, "critique.md");
    const shaderPath = join(prevDir, "shader.glsl");
    if (existsSync(critiquePath)) {
      priorCritique = readFileSync(critiquePath, "utf8");
      console.log(`[iterate-shader] picked up prior critique from iter-${nextIter - 1}`);
    }
    if (existsSync(shaderPath)) {
      priorShader = readFileSync(shaderPath, "utf8");
      console.log(`[iterate-shader] anchoring on prior shader from iter-${nextIter - 1}`);
    }
  }

  // ── Step 1. Generate or reuse the image atlas ──────────
  const atlasPath = join(iterDir, "atlas.png");
  const cachedAtlas = findCachedAtlas(conceptIterDir, ATLAS_SIZE);
  if (cachedAtlas) {
    console.log(`[iterate-shader] reusing atlas from ${cachedAtlas}`);
    writeFileSync(atlasPath, readFileSync(cachedAtlas));
  } else if (!concept.default_image_prompt) {
    console.log(`[iterate-shader] concept has no default_image_prompt — skipping atlas generation`);
  } else {
    console.log(`[iterate-shader] generating atlas via Nano Banana...`);
    await generateAtlas(concept.default_image_prompt, atlasPath);
  }

  // ── Step 2. Generate the GLSL ─────────────────────────
  console.log(`[iterate-shader] generating shader via ${MODEL_TEXT}...`);
  const shader = await generateGlsl(skillContent, conceptPrompt, priorCritique, priorShader);
  const shaderPath = join(iterDir, "shader.glsl");
  writeFileSync(shaderPath, shader);
  console.log(`[iterate-shader] shader saved (${shader.length} bytes)`);

  // ── Step 3. Persist the exact prompt used ────────────
  const fullPrompt = composePrompt(skillContent, conceptPrompt, priorCritique, priorShader);
  writeFileSync(join(iterDir, "prompt.txt"), fullPrompt);

  // ── Step 4. Capture via headless Chrome ──────────────
  console.log(`[iterate-shader] capturing 5 screenshots over 10s via headless Chrome...`);
  const previewBase = join(iterDir, "preview.webm");
  try {
    await captureShader(repoRoot, shaderPath, atlasPath, previewBase);
    const shots = readdirSync(iterDir).filter((f) => f.startsWith("preview-")).sort();
    console.log(`[iterate-shader] ${shots.length} screenshots saved`);
  } catch (err) {
    console.warn(`[iterate-shader] capture failed: ${(err as Error).message}`);
    writeFileSync(join(iterDir, "capture-error.txt"), (err as Error).message + "\n" + (err as Error).stack);
  }

  // ── Step 5. Stub critique file for human review ──────
  if (!existsSync(join(iterDir, "critique.md"))) {
    writeFileSync(join(iterDir, "critique.md"),
      `# Critique of ${conceptId} iter-${nextIter}\n\n` +
      `Flip through preview-01.png through preview-05.png in ${iterDir} and\n` +
      `write notes here. The next iteration will pick up this file as a\n` +
      `refinement message in the prompt.\n\n` +
      `## What worked\n\n- \n\n## What didn't\n\n- \n\n## Specific changes for next pass\n\n- \n`);
  }

  console.log(`[iterate-shader] done. View ${iterDir}/preview-*.png and edit ${iterDir}/critique.md.`);
}

// ── Atlas generation ────────────────────────────────────

async function generateAtlas(imagePrompt: string, outPath: string): Promise<void> {
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY,
  });
  const total = ATLAS_TILES_PER_ROW * ATLAS_TILES_PER_ROW;
  console.log(`[atlas] requesting ${total} tile images of ${TILE_SIZE}x${TILE_SIZE}...`);

  // Nano Banana doesn't render an atlas directly. We ask for one
  // composed atlas image at full resolution and let the model lay
  // out the grid internally. This is much faster than generating N
  // tiles and stitching them client-side.
  const atlasPrompt =
    `Create one square image (${ATLAS_SIZE}x${ATLAS_SIZE}) showing ` +
    `a grid of ${ATLAS_TILES_PER_ROW}x${ATLAS_TILES_PER_ROW} = ${total} ` +
    `distinct variations of: ${imagePrompt}. ` +
    `Each tile is ${TILE_SIZE}x${TILE_SIZE}. ` +
    `Variations differ in pose, color, and lighting but follow the same subject. ` +
    `Each tile is centered on its subject, isolated against a soft dark background. ` +
    `The composition is a clean grid with no gaps or borders between tiles.`;

  const response = await ai.models.generateContent({
    model: MODEL_IMAGE,
    contents: atlasPrompt,
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p: { inlineData?: { data?: string; mimeType?: string } }) => p.inlineData?.data);
  if (!imagePart?.inlineData?.data) {
    throw new Error("Nano Banana returned no image data");
  }
  const bytes = Buffer.from(imagePart.inlineData.data, "base64");
  writeFileSync(outPath, bytes);
  console.log(`[atlas] saved ${bytes.length} bytes to ${outPath}`);
}

function findCachedAtlas(conceptIterDir: string, expectedSize: number): string | null {
  // Look for any prior iteration that has a valid atlas.png. Atlases
  // are expensive to generate and stable for a concept, so reuse
  // when possible.
  if (!existsSync(conceptIterDir)) return null;
  const iters = readdirSync(conceptIterDir).sort().reverse();
  for (const iter of iters) {
    const candidate = join(conceptIterDir, iter, "atlas.png");
    if (existsSync(candidate)) {
      // We don't strictly verify the dimensions match — first one found wins.
      void expectedSize;
      return candidate;
    }
  }
  return null;
}

// ── GLSL generation ─────────────────────────────────────

async function generateGlsl(
  skillContent: string,
  conceptPrompt: string,
  priorCritique: string | null,
  priorShader: string | null,
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY,
  });
  const prompt = composePrompt(skillContent, conceptPrompt, priorCritique, priorShader);

  // Gemini Flash gets transient 503s when other pipelines (Milkdrop
  // annotate) hammer it in parallel. Retry with exponential backoff
  // on UNAVAILABLE so one transient overload doesn't kill an iter.
  const delays = [4_000, 10_000, 25_000, 60_000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL_TEXT,
        contents: prompt,
        config: {
          temperature: 0.6,
          // Shaders with multiple helpers and a thorough mainImage can
          // easily run 6000-10000 tokens. 32k is comfortable headroom.
          maxOutputTokens: 32_768,
        },
      });
      const text = response.text ?? "";
      return postProcess(extractGlslBlock(text));
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /503|UNAVAILABLE|overloaded|high demand/i.test(msg);
      if (!isTransient || attempt === delays.length) throw err;
      const waitMs = delays[attempt];
      console.log(`[iterate-shader] gemini ${msg.split("\n")[0]} — retry in ${waitMs}ms (attempt ${attempt + 1}/${delays.length})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr ?? new Error("unreachable");
}

/** Two cleanups so a slightly-noncompliant shader still compiles.
 *  1) Bake in iAtlasSize as a const since the Prism shadertoy backend
 *     does not set it.
 *  2) Strip redeclarations of the standard uniforms (iTime, iResolution,
 *     etc.) that the Prism preamble already provides. Gemini frequently
 *     adds these despite the skill prompt saying not to. */
function postProcess(glsl: string): string {
  // First, bake iAtlasSize.
  glsl = glsl.replace(
    /uniform\s+float\s+iAtlasSize\s*;.*$/m,
    `const float iAtlasSize = ${ATLAS_TILES_PER_ROW}.0;`,
  );
  // Then strip Prism-preamble uniform redeclarations.
  const standardUniforms = [
    "iTime",
    "iTimeDelta",
    "iFrame",
    "iResolution",
    "iMouse",
    "iChannel0",
    "iChannel1",
  ];
  for (const name of standardUniforms) {
    const re = new RegExp(`^\\s*uniform\\s+\\w+(?:\\s+\\w+)?\\s+${name}\\s*;.*$`, "gm");
    glsl = glsl.replace(re, `// uniform ${name} (provided by Prism preamble)`);
  }
  return glsl;
}

function composePrompt(
  skillContent: string,
  conceptPrompt: string,
  priorCritique: string | null,
  priorShader: string | null,
): string {
  let prompt =
    `You are the glsl-writer skill. Follow its conventions exactly.\n\n` +
    `--- SKILL CONTENT ---\n${skillContent}\n--- END SKILL ---\n\n` +
    `--- CONCEPT BRIEF ---\n${conceptPrompt}\n--- END BRIEF ---\n\n`;
  if (priorShader && priorCritique) {
    prompt +=
      `--- PRIOR SHADER (your starting point) ---\n\`\`\`glsl\n${priorShader}\n\`\`\`\n--- END PRIOR SHADER ---\n\n` +
      `--- PRIOR ITERATION CRITIQUE ---\n${priorCritique}\n--- END CRITIQUE ---\n\n` +
      `Apply the critique's specific changes to the prior shader. ` +
      `Preserve everything the critique does not call out. ` +
      `Return the full revised shader. Do not rewrite from scratch.\n\n`;
  } else if (priorCritique) {
    prompt +=
      `--- PRIOR ITERATION CRITIQUE ---\n${priorCritique}\n--- END CRITIQUE ---\n\n` +
      `Address the critique. Return the full revised shader.\n\n`;
  }
  prompt +=
    `Output only the GLSL source code in a single fenced \`\`\`glsl block. ` +
    `Do not include prose explanation. Start the code with helper functions and uniforms, ` +
    `then end with mainImage(out vec4 fragColor, in vec2 fragCoord).`;
  return prompt;
}

function extractGlslBlock(text: string): string {
  const match = text.match(/```glsl\s*\n([\s\S]*?)\n```/);
  if (match) return match[1];
  // Fallback: strip any other fence and trust the rest
  return text.replace(/^```\w*\s*\n?/, "").replace(/\n?```\s*$/, "");
}

// ── Capture via Puppeteer ───────────────────────────────

async function captureShader(
  repoRoot: string,
  shaderPath: string,
  atlasPath: string,
  outPath: string,
): Promise<void> {
  // We invoke an external helper script to keep the Puppeteer
  // dependency narrow. The existing scripts/pipelines/capture-pages/
  // shadertoy.html already does the rendering — we just point it at
  // a freshly-served shader URL with the atlas as the iChannel1 source.
  const { default: puppeteer } = await import("puppeteer");

  // Vite is expected to be running on localhost:5173. The shader file
  // lives in concepts/iterations/.../shader.glsl which Vite serves
  // as a static asset.
  const shaderUrl = `/${shaderPath.replace(repoRoot + "/", "")}`;
  const atlasUrl = existsSync(atlasPath) ? `/${atlasPath.replace(repoRoot + "/", "")}` : null;

  const captureUrl = new URL(
    "http://localhost:5173/scripts/pipelines/capture-pages/shadertoy.html",
  );
  captureUrl.searchParams.set("shaderUrl", shaderUrl);
  if (atlasUrl) captureUrl.searchParams.set("imageUrl", atlasUrl);

  // Match the flags the proven annotate command uses. Critical: the
  // autoplay-policy bypass, without which audioCtx.resume() hangs in
  // headless mode and the page never reaches __prismReady.
  const browser = await puppeteer.launch({
    headless: true,
    // Each page.screenshot call on a heavy WebGL2 frame loop can take
    // 60+ seconds; the default 30s protocol timeout was firing.
    protocolTimeout: 180_000,
    args: [
      "--use-angle=default",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--enable-gpu",
      "--disable-gpu-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      "--window-size=1280,720",
    ],
  });
  try {
    const page = await browser.newPage();
    // Smaller viewport. The page.screenshot calls in heavy WebGL2
    // contexts can be slow; halving the pixel count roughly halves
    // the time. 640x360 is enough to evaluate composition and motion.
    await page.setViewport({ width: 640, height: 360 });
    page.on("console", (msg) => {
      console.log(`  [page-${msg.type()}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
      console.log(`  [page-uncaught] ${err.message}`);
    });
    page.on("requestfailed", (req) => {
      console.log(`  [page-net-fail] ${req.url()} → ${req.failure()?.errorText ?? "?"}`);
    });
    await page.goto(captureUrl.toString(), { waitUntil: "networkidle2", timeout: 30_000 });

    // Manual polling instead of Puppeteer's waitForFunction. The heavy
    // shader frame loop monopolizes the JS event thread to the point
    // that Puppeteer's MutationObserver-based polling never fires.
    // page.evaluate runs immediately as a one-shot, so it gets through.
    await pollPageReady(page, 60_000);
    // We're not using __prismStartCapture / captureStream-based video
    // recording. That path produces empty WebMs in headless ANGLE on
    // macOS; we couldn't pin down why. Instead, take three PNG
    // screenshots over the 8-second window — enough to evaluate
    // motion + composition for iteration critiques.
    const shotTimes = [1000, 4000, 8000];
    for (let i = 0; i < shotTimes.length; i++) {
      const wait = i === 0 ? shotTimes[0] : shotTimes[i] - shotTimes[i - 1];
      await new Promise((r) => setTimeout(r, wait));
      const outPng = outPath.replace(/\.webm$/, `-${String(i + 1).padStart(2, "0")}.png`);
      // CDP's Page.captureScreenshot was hanging — the WebGL render
      // loop monopolizes Chrome's compositor on macOS ANGLE. Grab the
      // canvas pixels directly from inside the page via toDataURL,
      // which runs as a normal JS call and is not blocked by Skia.
      const dataUrl = await page.evaluate((): string => {
        const canvas = document.getElementById("vis") as HTMLCanvasElement | null;
        if (!canvas) throw new Error("canvas#vis not found");
        return canvas.toDataURL("image/png");
      });
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      writeFileSync(outPng, Buffer.from(base64, "base64"));
    }

  } finally {
    await browser.close();
  }
}

// Helpers for the manual polling approach.
async function pollPageReady(page: import("puppeteer").Page, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate(
      () => (window as unknown as { __prismReady?: boolean }).__prismReady === true,
    );
    if (ready) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`__prismReady never became true within ${timeoutMs}ms`);
}

async function pollCaptureReady(page: import("puppeteer").Page, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const done = await page.evaluate(
      () => (window as unknown as { __prismCaptureReady?: boolean }).__prismCaptureReady === true,
    );
    if (done) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`__prismCaptureReady never became true within ${timeoutMs}ms`);
}
