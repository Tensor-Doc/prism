// Image Pool — image reflected in water; FBM ripples driven by audio.
// Bass kicks send a circular shockwave outward. Tone-mapped at the end
// so sustained audio never clips to white. Original Prism v1.

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.0 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);

  float bass = 0.0;
  for (int i = 0; i < 16; i++) bass += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  bass /= 16.0;
  float mid = 0.0;
  for (int i = 20; i < 60; i++) mid += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  mid /= 40.0;
  float kick = bass * bass * 2.0; // dialed from 3.0

  // Ripple field
  float t = iTime * 0.2;
  vec2 q = vec2(fbm(uv * 3.5 + t), fbm(uv * 3.5 - t * 0.7));
  // Shockwave: kick sends a ring outward
  float ringRadius = mod(iTime * 0.4, 1.5);
  float dist = length(p);
  float ring = exp(-pow((dist - ringRadius) * 8.0, 2.0)) * kick * 0.8; // dialed

  vec2 ripple = (q - 0.5) * (0.04 + 0.08 * mid + 0.06 * bass) + p * ring * 0.04;

  vec3 col = texture(iChannel1, uv + ripple).rgb;

  // Top half is the reflection — slightly darker (water absorbs light)
  // with a faint cool tint. No blur: averaging samples was bleeding
  // highlights into a milky band, which the user perceived as the
  // "white glaze". The ripple distortion already sells "water"; the
  // darkening just signals where the surface is.
  if (uv.y > 0.5) {
    float depth = (uv.y - 0.5) * 2.0;          // 0 at surface, 1 at top
    col *= mix(1.0, 0.78, depth);              // up to 22% darker
    col = mix(col, col * vec3(0.92, 0.96, 1.0), depth * 0.5);
  }

  // Caustics as a MULTIPLIER — highlights existing colors instead of
  // painting cyan over dark areas. Only the brightest wave crests
  // trigger (raised threshold), and the effect modulates the source
  // image, never adding its own color veil.
  float caust = smoothstep(0.88, 1.20, q.x + q.y);
  col *= 1.0 + caust * (mid * 0.35 + ring * 0.45);

  // Removed the bass brightness pump entirely. It was the loudest
  // contributor to "everything goes white on a kick".

  // Vignette
  col *= 1.0 - 0.4 * smoothstep(0.6, 1.2, length(p));

  // Subtle warmth in the reflected part (low frequencies make the
  // water surface feel "lit"). Multiplicative, color-shifting, not
  // brightness-adding.
  col = mix(col, col * vec3(1.04, 0.97, 0.90), 0.12);

  // Reinhard tone-map so sustained audio + bright images never clip.
  col = col / (1.0 + col);
  // Gamma > 1 to deepen midtones and recover punch. Previous pow(0.85)
  // was the original culprit lifting midtones into the milky zone.
  col = pow(col, vec3(1.18));

  fragColor = vec4(col, 1.0);
}
