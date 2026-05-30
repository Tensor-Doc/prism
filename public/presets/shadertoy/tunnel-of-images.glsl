// Tunnel of Images — cylindrical tunnel with the image wrapped around
// the inside walls. IQ-style polar mapping (angle, 0.5/r + iTime*speed).
// Center vanishing point is dim (far), edges are bright walls (near).
// Audio modulates flight speed + brightness pumps; no geometry warp.
// Original Prism v1.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // Aspect-aware screen-centered coords; y in [-0.5, 0.5].
  vec2 p = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  // Audio bands
  float bass = 0.0;
  for (int i = 0; i < 12; i++) bass += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  bass /= 12.0;
  float treb = 0.0;
  for (int i = 60; i < 100; i++) treb += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  treb /= 40.0;
  float kick = bass * bass * 2.5;

  // Polar coords. NO lateral sway — keeps the vanishing point centered
  // so it feels like flying forward, not orbiting a moving cone tip.
  float r = length(p);
  float a = atan(p.y, p.x);

  // Cylindrical tunnel mapping:
  //   horizontal UV (angle) wraps the image once around the tunnel
  //   vertical UV (depth) advances with iTime — forward flight
  // r is clamped at 0.06 so the image doesn't compress to infinity at
  // the vanishing point. Speed dialed slow so the image is readable.
  float speed = 0.30 + bass * 0.6 + kick * 0.3;
  float depth = 0.5 / max(r, 0.06) + iTime * speed;
  vec2 uv = vec2(a / 6.28318, depth);

  vec3 col = texture(iChannel1, uv).rgb;

  // Atmospheric perspective: center (far) is DIM, edges (near walls)
  // are bright. smoothstep curve gives a soft falloff into the
  // vanishing point so the image fades naturally as it recedes.
  col *= smoothstep(0.05, 0.6, r);

  // A small cyan "light at the end of the tunnel" glow at the vanishing
  // point. Subtle — pulses on bass.
  float endLight = exp(-r * 8.0);
  col += vec3(0.24, 1.0, 0.9) * endLight * (0.3 + bass * 0.4);

  // Kick brightness pump — every beat lights up the whole frame slightly.
  col *= 1.0 + kick * 0.3;

  // Treble shifts overall warmth toward orange (gentle hue lift).
  col = mix(col, col * vec3(1.15, 0.95, 0.80), treb * 0.5);

  // Soft vignette
  col *= 1.0 - 0.35 * smoothstep(0.7, 1.2, length(p));

  // Reinhard tone-map so loud sections + bright images never blow out.
  col = col / (1.0 + col);
  col = pow(col, vec3(0.85));

  fragColor = vec4(col, 1.0);
}
