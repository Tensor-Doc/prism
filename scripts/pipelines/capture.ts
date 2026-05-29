// capture.ts — render a visualization in headless Chromium and capture
// a 16:9 WebM video from its canvas. Source-agnostic: the renderer's
// HTML page does the actual rendering; capture.ts just drives Puppeteer.
//
// The capture page (loaded via `renderUrl`) must:
//   1. Set up a single visible canvas covering the full page
//   2. Expose `window.__prismReady = true` when first frames are paintable
//   3. Expose `window.__prismStartCapture(durationMs)` to begin recording
//   4. Set `window.__prismVideoBase64` (and `window.__prismCaptureReady`)
//      when the recording is complete
//
// This contract is implemented by each renderer's capture-pages/<id>.html.

import puppeteer from "puppeteer";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { CaptureConfig } from "./types";

export async function captureVideo(
  renderUrl: string,
  outputPath: string,
  config: CaptureConfig,
): Promise<void> {
  await fs.mkdir(dirname(outputPath), { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      // Force a GL backend that works in headless. swiftshader is software
      // GL — slower but reliable. For hardware GL replace with `--use-gl=angle`
      // and provide a display server.
      "--use-gl=swiftshader",
      "--enable-webgl",
      "--enable-accelerated-2d-canvas",
      "--ignore-gpu-blocklist",
      // Allow autoplay so the capture page's backing music starts without a
      // user gesture (needed for milkdrop audio-reactive captures).
      "--autoplay-policy=no-user-gesture-required",
      `--window-size=${config.width},${config.height}`,
    ],
    defaultViewport: { width: config.width, height: config.height },
  });

  try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      // Pass through page console to ease debugging.
      if (msg.type() === "error") console.error("[page]", msg.text());
    });
    page.on("pageerror", (err) => console.error("[page-error]", err.message));

    await page.setViewport({ width: config.width, height: config.height });
    await page.goto(renderUrl, { waitUntil: "networkidle0", timeout: 30_000 });

    // Wait for the page to flip __prismReady — that's when the renderer says
    // its first frame is ready to be captured.
    await page.waitForFunction(
      () => (window as unknown as { __prismReady?: boolean }).__prismReady === true,
      { timeout: config.readyTimeoutMs ?? 15_000 },
    );

    // Begin recording.
    await page.evaluate((durationMs) => {
      const start = (window as unknown as {
        __prismStartCapture?: (d: number) => void;
      }).__prismStartCapture;
      if (typeof start !== "function") throw new Error("capture-page missing __prismStartCapture");
      start(durationMs);
    }, config.durationMs);

    // Block until the page signals the encoded video is available.
    await page.waitForFunction(
      () => (window as unknown as { __prismCaptureReady?: boolean }).__prismCaptureReady === true,
      { timeout: config.durationMs + 30_000 },
    );

    const base64 = await page.evaluate(
      () => (window as unknown as { __prismVideoBase64?: string }).__prismVideoBase64 ?? "",
    );
    if (!base64) throw new Error("capture-page produced empty video");

    await fs.writeFile(outputPath, Buffer.from(base64, "base64"));
  } finally {
    await browser.close();
  }
}
