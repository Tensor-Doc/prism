// Public entry point for prism-player.
// Real PrismPlayer class lands in M4; for now the package exports the
// graph schema, runtime, and backends so the site can use them directly.
export * from "./types";
export * from "./runtime";
export {
  createMilkdropBackground,
  type MilkdropBg,
  type MilkdropBgOptions,
} from "./backends/milkdrop";
export {
  createShadertoyBackground,
  type ShadertoyBg,
} from "./backends/shadertoy";
