// Compositor presets — short WGSL bodies that go inside `fn compose(uv) -> vec3f`.
// Helpers available: sample_fluid(uv), sample_milkdrop(uv),
// chaos_amt(), bass(), mid(), treble(), beat(), t_s(), has_milkdrop().

export interface CompositorPreset {
  name: string;
  body: string;
}

export const BUILTIN_COMPOSITORS: CompositorPreset[] = [
  {
    name: "fluid only",
    body: `  return sample_fluid(uv);`,
  },
  {
    name: "milkdrop only",
    body: `  return sample_milkdrop(uv) * has_milkdrop();`,
  },
  {
    name: "screen blend (chaos)",
    body: `  let f = sample_fluid(uv);
  let m = sample_milkdrop(uv) * has_milkdrop();
  return vec3f(1.0) - (vec3f(1.0) - f) * (vec3f(1.0) - m * chaos_amt());`,
  },
  {
    name: "linear mix (chaos)",
    body: `  let f = sample_fluid(uv);
  let m = sample_milkdrop(uv) * has_milkdrop();
  return mix(f, m, chaos_amt());`,
  },
  {
    name: "milkdrop warps fluid",
    body: `  let mk = sample_milkdrop(uv) * has_milkdrop();
  let disp = (mk.rg - 0.5) * 0.08 * chaos_amt();
  let warped = uv + disp;
  return sample_fluid(warped) + mk * 0.15 * chaos_amt();`,
  },
  {
    name: "fluid warps milkdrop",
    body: `  let f = sample_fluid(uv);
  let disp = (f.rg - 0.5) * 0.06;
  let warped = uv + disp;
  let mk = sample_milkdrop(warped) * has_milkdrop();
  return mix(f, mk, chaos_amt() * 0.7);`,
  },
  {
    name: "beat swap",
    body: `  let mix_amt = clamp(chaos_amt() + beat() * 0.6, 0.0, 1.0);
  return mix(sample_fluid(uv), sample_milkdrop(uv), mix_amt);`,
  },
  {
    name: "bass tunnel",
    body: `  let c = uv - vec2f(0.5);
  let r = length(c);
  let a = atan2(c.y, c.x);
  let warp = vec2f(cos(a), sin(a)) * (r + 0.05 * sin(t_s() * 1.4 + bass() * 6.0));
  let warped = warp + vec2f(0.5);
  let f = sample_fluid(warped);
  let m = sample_milkdrop(warped) * has_milkdrop();
  return mix(f, m, chaos_amt());`,
  },
  {
    name: "nasa gallery",
    body: `  // Cycle through the 4 NASA images every 6s with crossfade + Ken Burns motion.
  let cycle = 6.0;
  let phase = fract(t_s() / cycle);
  let slot_a = floor(t_s() / cycle) % 4.0;
  let slot_b = (slot_a + 1.0) % 4.0;
  // Crossfade in the last 18% of the cycle.
  let blend = smoothstep(0.82, 1.0, phase);
  // Ken Burns: gentle zoom + slow drift, modulated by bass for life.
  let z = 1.0 + 0.10 * sin(phase * 3.14159) + bass() * 0.18;
  let drift = vec2f(sin(t_s() * 0.11), cos(t_s() * 0.13)) * 0.045;
  let centered = (uv - 0.5) / z + 0.5 + drift;
  let img_a = sample_nasa(slot_a, centered);
  let img_b = sample_nasa(slot_b, centered);
  let img = mix(img_a, img_b, blend);
  // Bass swells brightness; beats add a brief flash.
  return img * (1.0 + bass() * 0.25 + beat() * 0.40);`,
  },
];

const STORAGE_KEY = "prism.compositor.presets";
const SELECTED_KEY = "prism.compositor.selected";

interface StoredPreset {
  name: string;
  body: string;
}

export function loadUserPresets(): CompositorPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p): p is StoredPreset =>
        typeof p === "object" && p !== null &&
        typeof (p as StoredPreset).name === "string" &&
        typeof (p as StoredPreset).body === "string",
      )
      .map((p) => ({ name: p.name, body: p.body }));
  } catch {
    return [];
  }
}

export function saveUserPresets(presets: CompositorPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // ignore
  }
}

export function loadSelectedName(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

export function saveSelectedName(name: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, name);
  } catch {
    // ignore
  }
}
