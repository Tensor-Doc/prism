import type { AudioFeatures } from "./audio-features";

export type ColorChannel = number | string;

export interface InjectionSpec {
  type?: "single";
  name?: string;
  x: string;
  y: string;
  intensity: string;
  sigma: string;
  color: [ColorChannel, ColorChannel, ColorChannel];
  source?: string;
  vortex?: string;
}

export interface ArrayInjectionSpec {
  type: "array";
  name?: string;
  count: number;
  x: string;
  y: string;
  intensity: string;
  sigma: string;
  color: [ColorChannel, ColorChannel, ColorChannel];
  source?: string;
  vortex?: string;
}

export type AnyInjectionSpec = InjectionSpec | ArrayInjectionSpec;

export interface PhysicsSpec {
  flow_strength?: number;
  flow_scale?: number;
  bass_flow_coupling?: number;
  damping?: number;
  max_age?: number;
  particle_size?: number;
  spawn_rate?: number;
}

export interface PresetSpec {
  name: string;
  fade?: number;
  physics?: PhysicsSpec;
  injections: AnyInjectionSpec[];
}

export type ScalarExpr = (audio: AudioFeatures, t: number) => number;

export interface CompiledInjection {
  name: string;
  x: ScalarExpr;
  y: ScalarExpr;
  intensity: ScalarExpr;
  sigma: ScalarExpr;
  color: [ScalarExpr, ScalarExpr, ScalarExpr];
  source: ScalarExpr;
  vortex: ScalarExpr;
}

export interface CompiledPreset {
  name: string;
  fade: number;
  physics: Required<PhysicsSpec>;
  injections: CompiledInjection[];
}

export const DEFAULT_PHYSICS: Required<PhysicsSpec> = {
  flow_strength: 0.008,
  flow_scale: 1.4,
  bass_flow_coupling: 0.025,
  damping: 12.0,
  max_age: 7.0,
  particle_size: 8.0,
  spawn_rate: 3000,
};

const ENV_NAMES = [
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
  "abs", "sqrt", "pow", "exp", "log",
  "min", "max", "floor", "ceil", "round",
  "PI", "E", "TAU",
  "clamp", "mix", "smoothstep",
] as const;

const ENV = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  abs: Math.abs, sqrt: Math.sqrt, pow: Math.pow, exp: Math.exp, log: Math.log,
  min: Math.min, max: Math.max,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  PI: Math.PI, E: Math.E, TAU: Math.PI * 2,
  clamp: (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v)),
  mix: (a: number, b: number, t: number) => a + (b - a) * t,
  smoothstep: (e0: number, e1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  },
};

type EnvTuple = [
  typeof ENV.sin, typeof ENV.cos, typeof ENV.tan,
  typeof ENV.asin, typeof ENV.acos, typeof ENV.atan, typeof ENV.atan2,
  typeof ENV.abs, typeof ENV.sqrt, typeof ENV.pow, typeof ENV.exp, typeof ENV.log,
  typeof ENV.min, typeof ENV.max,
  typeof ENV.floor, typeof ENV.ceil, typeof ENV.round,
  number, number, number,
  typeof ENV.clamp, typeof ENV.mix, typeof ENV.smoothstep,
];

const ENV_ARGS: EnvTuple = ENV_NAMES.map((n) => ENV[n]) as EnvTuple;

function compileExpr(expr: string, fallback = 0): ScalarExpr {
  let fn: (...a: unknown[]) => unknown;
  try {
    fn = new Function(
      "audio",
      "t",
      "Math",
      ...ENV_NAMES,
      `return (${expr});`,
    ) as typeof fn;
  } catch (e) {
    console.warn(`prism: failed to compile expression "${expr}":`, e);
    return () => fallback;
  }
  return (audio, t) => {
    try {
      const v = fn(audio, t, Math, ...ENV_ARGS);
      if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
      return v;
    } catch {
      return fallback;
    }
  };
}

function compileChannel(v: ColorChannel | undefined, fallback = 1): ScalarExpr {
  if (typeof v === "number") {
    const x = v;
    return () => x;
  }
  if (typeof v === "string") {
    return compileExpr(v, fallback);
  }
  return () => fallback;
}

function substituteIndex(expr: string, i: number): string {
  // Replace bare `i` with the literal index. Word-boundary protects identifiers
  // like `sin`, `pi`, `audio.bin(...)`, etc.
  return expr.replace(/\bi\b/g, String(i));
}

function substituteChannel(c: ColorChannel | undefined, i: number): ColorChannel | undefined {
  if (typeof c === "string") return substituteIndex(c, i);
  return c;
}

function expandArray(spec: ArrayInjectionSpec): InjectionSpec[] {
  const out: InjectionSpec[] = [];
  const baseName = spec.name ?? "array";
  for (let i = 0; i < spec.count; i++) {
    out.push({
      name: `${baseName}-${i}`,
      x: substituteIndex(spec.x, i),
      y: substituteIndex(spec.y, i),
      intensity: substituteIndex(spec.intensity, i),
      sigma: substituteIndex(spec.sigma, i),
      color: [
        substituteChannel(spec.color?.[0], i) ?? 1,
        substituteChannel(spec.color?.[1], i) ?? 1,
        substituteChannel(spec.color?.[2], i) ?? 1,
      ],
      source: spec.source !== undefined ? substituteIndex(spec.source, i) : undefined,
      vortex: spec.vortex !== undefined ? substituteIndex(spec.vortex, i) : undefined,
    });
  }
  return out;
}

function flattenInjections(specs: AnyInjectionSpec[] | undefined): InjectionSpec[] {
  if (!specs) return [];
  const out: InjectionSpec[] = [];
  for (const entry of specs) {
    if (entry.type === "array") {
      out.push(...expandArray(entry));
    } else {
      out.push(entry);
    }
  }
  return out;
}

export function compilePreset(p: PresetSpec): CompiledPreset {
  const flat = flattenInjections(p.injections);
  return {
    name: p.name,
    fade: p.fade ?? 0.08,
    physics: { ...DEFAULT_PHYSICS, ...(p.physics ?? {}) },
    injections: flat.map((inj, i) => ({
      name: inj.name ?? `injection-${i}`,
      x: compileExpr(inj.x, 0.5),
      y: compileExpr(inj.y, 0.5),
      intensity: compileExpr(inj.intensity, 0),
      sigma: compileExpr(inj.sigma, 0.05),
      color: [
        compileChannel(inj.color?.[0], 1),
        compileChannel(inj.color?.[1], 1),
        compileChannel(inj.color?.[2], 1),
      ],
      source: compileExpr(inj.source ?? "0", 0),
      vortex: compileExpr(inj.vortex ?? "0", 0),
    })),
  };
}
