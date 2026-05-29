export interface Tuning {
  inject_gain: number;
  decay: number;
  diffusion: number;
  flow_strength: number;
  flow_scale: number;
  bass_flow: number;
  gravity: number;
  mass: number;
  waves: number;
  music_motion: number;
  slope_gain: number;
  saturation: number;
  chroma: number;
  hue: number;
  hue_speed: number;
  beat_relief: number;
  paint: number;
  chaos: number;
}

const LABELS: Record<keyof Tuning, string> = {
  inject_gain: "inject",
  decay: "decay",
  diffusion: "diffuse",
  flow_strength: "flow",
  flow_scale: "scale",
  bass_flow: "bass→flow",
  gravity: "gravity",
  mass: "mass",
  waves: "waves",
  music_motion: "music↻",
  slope_gain: "relief",
  saturation: "vivid",
  chroma: "chroma",
  hue: "hue",
  hue_speed: "hue↻",
  beat_relief: "beat→relief",
  paint: "nasa-paint",
  chaos: "chaos",
};

function formatValue(v: number): string {
  if (Math.abs(v) >= 10) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

export function createTuning(board: HTMLElement): Tuning {
  const tuning = {} as Tuning;
  const sliders = board.querySelectorAll<HTMLDivElement>(".dj-slider");

  for (const slider of sliders) {
    const key = slider.dataset.key as keyof Tuning;
    const min = parseFloat(slider.dataset.min ?? "0");
    const max = parseFloat(slider.dataset.max ?? "1");
    const step = parseFloat(slider.dataset.step ?? "0.01");
    const initial = parseFloat(slider.dataset.default ?? "0");

    tuning[key] = initial;

    const label = document.createElement("label");
    label.textContent = LABELS[key] ?? key;

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);

    const valueDisplay = document.createElement("span");
    valueDisplay.className = "dj-value";
    valueDisplay.textContent = formatValue(initial);

    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      tuning[key] = v;
      valueDisplay.textContent = formatValue(v);
    });

    slider.append(label, input, valueDisplay);
  }

  return tuning;
}
