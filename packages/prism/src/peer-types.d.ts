// Ambient declarations for the three peer-dep packages that ship without
// types. We treat their default exports as `unknown` here and refine
// inside the backend wrappers via structural casts — that keeps the
// emitted .d.ts files clean (no implicit any) without pulling in the
// upstream JS shapes we don't actually want to depend on.
declare module "butterchurn" {
  const m: unknown;
  export default m;
}

declare module "butterchurn-presets" {
  const m: unknown;
  export default m;
}

declare module "milkdrop-preset-converter" {
  export const convertPreset: (text: string) => Promise<unknown>;
}
