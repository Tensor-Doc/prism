// Image Pool — an image reflected in water; ripples driven by FBM noise +
// audio. Slow, contemplative; the image breathes underneath. Original Prism v1.

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

  // Audio: gentle modulation, mid/treble for ripple intensity
  float mid = 0.0;
  for (int i = 20; i < 60; i++) {
    mid += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  }
  mid /= 40.0;

  // Ripple field — slowly evolving FBM
  float t = iTime * 0.18;
  vec2 q = vec2(fbm(uv * 3.0 + t), fbm(uv * 3.0 - t * 0.7));
  vec2 ripple = (q - 0.5) * (0.04 + 0.06 * mid);

  // Sample displaced image
  vec3 col = texture(iChannel1, uv + ripple).rgb;

  // Top half slight blur via multi-sample to fake reflection
  if (uv.y > 0.5) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      vec2 off = vec2(0.005, 0.0) * float(i - 2);
      acc += texture(iChannel1, uv + ripple + off).rgb;
    }
    col = mix(col, acc / 5.0, 0.4);
  }

  // Cyan caustic shimmer where ripple is bright
  float caust = smoothstep(0.55, 0.95, q.x + q.y);
  col += vec3(0.24, 1.0, 0.9) * caust * 0.15 * (0.5 + mid);

  // Brand-orange warm undertone in the deeps
  col = mix(col, col * vec3(1.05, 0.95, 0.85), 0.2);

  // Vignette
  col *= 1.0 - 0.4 * smoothstep(0.6, 1.2, length((uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0)));

  fragColor = vec4(col, 1.0);
}
