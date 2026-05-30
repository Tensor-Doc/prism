// Image Pool — image reflected in water; FBM ripples driven by audio
// (much stronger on mid + kick). Bass kicks send a circular shockwave
// outward from center. Original Prism v1.

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
  float kick = bass * bass * 3.0;

  // Ripple field — FBM scales with audio intensity
  float t = iTime * 0.2;
  vec2 q = vec2(fbm(uv * 3.5 + t), fbm(uv * 3.5 - t * 0.7));
  // Shockwave: kick sends a ring outward
  float ringRadius = mod(iTime * 0.4, 1.5);
  float dist = length(p);
  float ring = exp(-pow((dist - ringRadius) * 8.0, 2.0)) * kick * 1.5;

  vec2 ripple = (q - 0.5) * (0.04 + 0.12 * mid + 0.10 * bass) + p * ring * 0.05;

  vec3 col = texture(iChannel1, uv + ripple).rgb;

  // Reflection blur on top half
  if (uv.y > 0.5) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      vec2 off = vec2(0.005, 0.0) * float(i - 2);
      acc += texture(iChannel1, uv + ripple + off).rgb;
    }
    col = mix(col, acc / 5.0, 0.4);
  }

  // Cyan caustics — much brighter on mid + ring
  float caust = smoothstep(0.55, 0.95, q.x + q.y);
  col += vec3(0.24, 1.0, 0.9) * caust * (0.2 + mid * 0.8 + ring);

  // Bass kick brightness pump
  col *= 1.0 + kick * 0.5;

  // Warm undertone
  col = mix(col, col * vec3(1.05, 0.95, 0.85), 0.2);

  // Vignette
  col *= 1.0 - 0.4 * smoothstep(0.6, 1.2, length(p));

  fragColor = vec4(col, 1.0);
}
