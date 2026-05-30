// Audio Spectrum — 64 vertical bars driven by iChannel0 FFT, cyan→orange
// gradient, with mirror at top + soft bloom underneath. Falls back to a
// time-driven "phantom" wave when audio is silent so the canvas is never
// pure black. Original Prism v1.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;

  // 64 bars across the screen.
  float barIdx = floor(uv.x * 64.0);
  float bar = texture(iChannel0, vec2(barIdx / 256.0 * 0.7 + 0.02, 0.5)).x;
  bar = pow(bar, 1.4); // emphasize peaks

  // Fallback phantom wave when audio is silent: a slow sine pattern so
  // the visualization is never pure black even while AudioContext is
  // suspended (pre-first-click).
  float phantom = 0.20 + 0.15 * sin(iTime * 1.3 + barIdx * 0.4) +
                  0.10 * sin(iTime * 0.7 + barIdx * 0.21);
  bar = max(bar, phantom);

  // Mirror around middle Y.
  float h = abs(uv.y - 0.5) * 2.0;
  float lit = step(h, bar);

  // Bar interior color: cyan at bottom (low h), orange at top of bar.
  vec3 cyan = vec3(0.24, 1.0, 0.9);
  vec3 orange = vec3(1.0, 0.47, 0.28);
  vec3 inside = mix(cyan, orange, h / max(bar, 0.001));

  // Soft glow outside the lit area (additive).
  float glow = exp(-(h - bar) * 8.0) * step(bar, h);
  vec3 ground = vec3(0.04, 0.05, 0.08);

  vec3 col = ground;
  col = mix(col, inside, lit);
  col += cyan * glow * 0.25;

  // Subtle background drift so the canvas isn't dead.
  float bg = 0.08 + 0.06 * sin(iTime + uv.y * 6.0);
  col += vec3(0.05, 0.09, 0.12) * bg;

  fragColor = vec4(col, 1.0);
}
