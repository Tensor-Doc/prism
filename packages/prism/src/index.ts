// Public entry point for /prism.
export {
  PrismPlayer,
  type PrismPlayerOptions,
  type GraphInput,
  type ImageSource,
} from "./player";
export { HeadlessSlideshow, type SlideshowOptions } from "./image-feed";
export {
  ImageOverlay,
  type ImageOverlayOptions,
  type OverlayState,
  type Rect,
} from "./image-overlay";
export { GraphRuntime, type ApplyResult, type RuntimeContext } from "./runtime";
export { SyntheticSignal } from "./synth";
export {
  createMilkdropBackground,
  type MilkdropBg,
  type MilkdropBgOptions,
} from "./backends/milkdrop";
export {
  createShadertoyBackground,
  type ShadertoyBg,
} from "./backends/shadertoy";
export { lookup, shortIds, shortIdToGraph, type RegistryEntry } from "./registry";
export * from "./types";
