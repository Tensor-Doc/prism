// Tunnel of Images — fly through a weaving water-ride tube with the
// image wrapped around the inside walls. The vanishing point drifts on
// a smooth sin/cos path so the tube snakes left, right, up, down as we
// fly forward. The tube itself slowly rotates around the flight axis
// for that lazy-river curl. Audio only modulates ambient brightness;
// the forward speed is constant so the ride never lurches.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // Aspect-aware screen coords; y in [-0.5, 0.5].
  vec2 p = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  // Audio bands. Bass drives ambient lift only — NOT motion.
  float bass = 0.0;
  for (int i = 0; i < 12; i++) {
    bass += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  }
  bass /= 12.0;
  float treb = 0.0;
  for (int i = 60; i < 100; i++) {
    treb += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  }
  treb /= 40.0;

  // The flight path. Two frequencies per axis so the weave never
  // repeats. Amplitudes kept under 0.20 so the vanishing point stays
  // mostly on-screen.
  vec2 pathOffset = vec2(
    sin(iTime * 0.55) * 0.13 + sin(iTime * 0.33) * 0.06,
    cos(iTime * 0.48) * 0.13 + cos(iTime * 0.29) * 0.06
  );
  vec2 pc = p - pathOffset;

  // Polar around the moving center.
  float r = length(pc);
  float a = atan(pc.y, pc.x);

  // Rotation around the long axis — gives that lazy-river curl as we
  // fly forward. Without it the wall texture feels frozen.
  a += iTime * 0.18;

  // Cylindrical mapping. depth advances at a CONSTANT speed; bass
  // touches brightness later, not motion. Speed picked so the walls
  // genuinely rush past instead of crawling.
  float depth = 0.5 / max(r, 0.06) + iTime * 1.10;
  vec2 uv = vec2(a / 6.28318, depth);

  vec3 col = texture(iChannel1, uv).rgb;

  // Atmospheric perspective: far center is dim, near walls are bright.
  col *= smoothstep(0.04, 0.55, r);

  // Soft cyan glow at the vanishing point — a small "light at the end
  // of the tunnel". Gentle bass pulse, not a beat punch.
  float endLight = exp(-r * 9.0);
  col += vec3(0.20, 0.85, 0.85) * endLight * (0.22 + bass * 0.18);

  // Ambient brightness lift from bass. Subtle — keeps the ride calm.
  col *= 1.0 + bass * 0.12;

  // Vignette so the screen-corner geometry doesn't pull the eye.
  col *= 1.0 - 0.30 * smoothstep(0.70, 1.20, length(p));

  // Reinhard tone map so a loud bass stretch never crushes to white.
  col = col / (1.0 + col);
  col = pow(col, vec3(0.85));

  // Treble lifts cyan slightly so high-frequency content reads as
  // sparkle on the wet walls. Very mild.
  col = mix(col, col * vec3(0.95, 1.05, 1.10), treb * 0.25);

  fragColor = vec4(col, 1.0);
}
