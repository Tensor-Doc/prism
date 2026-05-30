// Minimal type stub for milkdrop-preset-converter — ships as CJS without
// types. We only use convertPreset; structural casting handles the rest.
declare module "milkdrop-preset-converter" {
  export function convertPreset(milkText: string): unknown;
  export function convertShader(text: string): unknown;
  export function convertPresetEquations(text: string): unknown;
  export function convertWaveEquations(text: string): unknown;
  export function convertShapeEquations(text: string): unknown;
}
