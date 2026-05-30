// Tunnel of Images — polar-mapped cylindrical tunnel with image wrap.
// The image is the substance; the tunnel is the lens. Audio modulates
// flight speed + brightness pumps + rim color shifts but does NOT
// distort the image past recognition. Original Prism v1.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 p = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  // Three audio bands, sampled wide for robustness.
  float bass = 0.0;
  for (int i = 0; i < 12; i++) bass += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  bass /= 12.0;
  float treb = 0.0;
  for (int i = 60; i < 100; i++) treb += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  treb /= 40.0;

  // Snappy bass "kick" — squared bass for sharp peaks
  float kick = bass * bass * 3.0;

  // Slow lateral sway so the tunnel snakes rather than going straight.
  vec2 center = vec2(0.15 * sin(iTime * 0.25), 0.12 * cos(iTime * 0.31));
  vec2 q = p - center;
  float r = length(q);
  float a = atan(q.y, q.x);

  // Cylindrical UV: angle wraps horizontally, depth scrolls forward.
  // Slower base speed so the image is readable; bass adds gentle push.
  float speed = 0.35 + bass * 0.5 + kick * 0.4;
  float depth = 1.0 / max(r, 0.001) + iTime * speed;
  vec2 uv = vec2(a / 6.28318, depth);

  // Sample the image — KEEP IT RECOGNIZABLE. No coord distortion here.
  vec3 col = texture(iChannel1, uv).rgb;

  // Depth fog (atmospheric perspective) — center stays bright, edges dim
  float fog = exp(-r * 1.2);
  col *= 0.45 + 0.65 * fog;

  // Bass kick brightness pump (subtle — keeps image visible)
  col *= 1.0 + kick * 0.35;

  // Cyan rim glow near the tunnel mouth; treble briefly intensifies it
  float rim = smoothstep(0.0, 0.7, fog);
  col += vec3(0.24, 1.0, 0.9) * rim * (0.15 + bass * 0.3 + treb * 0.2);

  // Orange warmth at the periphery, pulses with bass
  float periph = smoothstep(0.5, 1.4, r);
  col = mix(col, col * vec3(1.15, 0.85, 0.75), periph * (0.4 + bass * 0.3));

  // Soft vignette
  col *= 1.0 - 0.4 * smoothstep(0.6, 1.1, length(p));

  fragColor = vec4(col, 1.0);
}
