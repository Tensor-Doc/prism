// Generic image-source abstraction. Anything that can produce visual
// pixels for a sampler slot implements this — tab video, NASA APOD,
// user upload, AI-generated, social feed, etc. Skills declare image
// sampler inputs without caring where the pixels come from; the runtime
// brokers which source fills which slot.

export type ImageSourceType =
  | "tab-video"
  | "nasa-apod"
  | "url"
  | "upload"
  | "ai-generated"
  | "static";

export interface ImageSource {
  readonly id: string;
  readonly type: ImageSourceType;
  /** Whether a sample is currently available. */
  isReady(): boolean;
  /** Render a fresh sample into the target canvas. Resolves with whether
   *  the target was actually written to. */
  sample(target: HTMLCanvasElement | OffscreenCanvas): Promise<boolean>;
  /** Hint to the runtime about the natural refresh cadence of this source. */
  defaultPeriodMs(): number;
}
