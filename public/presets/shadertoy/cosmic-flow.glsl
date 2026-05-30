// Cosmic Flow — slow rolling fluid field, FBM noise driven, audio-reactive
// brightness. Painterly cyan/orange palette. Original work for Prism v1.

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.0 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

// IQ-style cosine palette
vec3 palette(float t) {
  return vec3(0.05) + vec3(0.4, 0.3, 0.5) * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.33, 0.67)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  // Sample bass band from audio FFT (first ~16 bins)
  float bass = 0.0;
  for (int i = 0; i < 16; i++) {
    bass += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  }
  bass /= 16.0;

  float t = iTime * 0.15;
  vec2 q = vec2(fbm(uv + t), fbm(uv * 1.4 - t * 0.7));
  vec2 r = vec2(fbm(uv + q + vec2(1.7, 9.2) + 0.15 * t),
                fbm(uv + q + vec2(8.3, 2.8) + 0.13 * t));
  float f = fbm(uv + r * (1.5 + bass * 1.5));

  vec3 col = palette(f + bass * 0.3 + 0.1 * iTime);
  col *= 0.9 + 0.7 * smoothstep(0.0, 1.0, f);
  // Cyan accent on highlights, orange in mids — brand colors
  col = mix(col, vec3(0.24, 1.0, 0.9), smoothstep(0.7, 1.1, f) * 0.4);
  col = mix(col, vec3(1.0, 0.55, 0.25), smoothstep(0.3, 0.55, f) * 0.15);

  fragColor = vec4(col, 1.0);
}
