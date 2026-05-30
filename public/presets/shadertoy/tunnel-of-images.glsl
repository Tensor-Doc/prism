// Tunnel of Images — polar-mapped cylindrical tunnel with image wrap;
// audio drives flight speed, bass kicks flash brightness + zoom, treble
// shifts hue toward cyan/orange. Original Prism v1.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 p = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  // Three audio bands — sample wider so signal is robust.
  float bass = 0.0;
  for (int i = 0; i < 12; i++) bass += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  bass /= 12.0;
  float mid = 0.0;
  for (int i = 16; i < 56; i++) mid += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  mid /= 40.0;
  float treb = 0.0;
  for (int i = 60; i < 100; i++) treb += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  treb /= 40.0;

  // Snappy bass "kick" — squared bass amplifies peaks dramatically
  float kick = bass * bass * 3.0;

  // Slow winding sway + bass-driven center bulge
  vec2 center = vec2(0.18 * sin(iTime * 0.27), 0.18 * cos(iTime * 0.31));
  vec2 q = (p - center) * (1.0 - kick * 0.15);  // zoom on kicks
  float r = length(q);
  float a = atan(q.y, q.x);

  // Cylindrical UV: angle wraps horizontally, depth scrolls forward.
  float speed = 0.6 + bass * 2.4 + kick;
  float depth = 1.0 / max(r, 0.001) + iTime * speed;
  // Treble jitters the depth scrolling per-angle for fizz at the rim
  depth += treb * 0.5 * sin(a * 20.0 + iTime * 8.0);
  vec2 uv = vec2(a / 6.28318, depth);

  vec3 col = texture(iChannel1, uv).rgb;
  float fog = exp(-r * 1.4);
  col *= 0.3 + 0.6 * fog;

  // Bass kick brightness flash — pumps the whole frame on every beat
  col *= 1.0 + kick * 0.8;

  // Cyan rim near tunnel mouth, stronger on bass
  float rim = smoothstep(0.0, 0.7, fog);
  col += vec3(0.24, 1.0, 0.9) * rim * (0.25 + bass * 0.7);

  // Treble pushes overall warmth toward orange (subtle color shift)
  col = mix(col, col * vec3(1.2, 0.9, 0.8), treb);

  // Vignette
  col *= 1.0 - 0.5 * smoothstep(0.5, 1.0, length(p));

  fragColor = vec4(col, 1.0);
}
