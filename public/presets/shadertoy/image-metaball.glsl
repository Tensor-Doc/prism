// Image Metaball — single SDF blob with matcap-style image sampling;
// bass kicks burst the blob in size + brightness, treble shimmers the
// surface. Original Prism v1.

float sdSphere(vec3 p, float r) { return length(p) - r; }

float scene(vec3 p, float aud, float kick) {
  // Bass kicks pump radius hard, sustained bass slowly grows it
  float r = 0.7 + aud * 0.4 + kick * 0.35 + 0.08 * sin(iTime * 1.2);
  // Surface ripples scaled by treble
  float rip = 0.07 * sin(8.0 * p.x + iTime) * sin(8.0 * p.y + iTime * 1.3);
  return sdSphere(p, r) + rip * aud;
}

vec3 normal(vec3 p, float aud, float kick) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    scene(p + e.xyy, aud, kick) - scene(p - e.xyy, aud, kick),
    scene(p + e.yxy, aud, kick) - scene(p - e.yxy, aud, kick),
    scene(p + e.yyx, aud, kick) - scene(p - e.yyx, aud, kick)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  float bass = 0.0;
  for (int i = 0; i < 16; i++) bass += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  bass /= 16.0;
  float treb = 0.0;
  for (int i = 60; i < 100; i++) treb += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  treb /= 40.0;
  float kick = bass * bass * 2.5;

  vec3 ro = vec3(0.0, 0.0, -2.5);
  vec3 rd = normalize(vec3(uv, 1.4));

  float ct = cos(iTime * 0.15), st = sin(iTime * 0.15);
  ro.xz = mat2(ct, st, -st, ct) * ro.xz;
  rd.xz = mat2(ct, st, -st, ct) * rd.xz;

  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < 80; i++) {
    vec3 p = ro + rd * t;
    float d = scene(p, bass, kick);
    if (d < 0.001) { hit = true; break; }
    if (t > 8.0) break;
    t += d;
  }

  vec3 col = vec3(0.03, 0.04, 0.07);
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = normal(p, bass, kick);
    // Matcap-style: normal → image UV. Treble offsets the UV for shimmer.
    vec2 muv = n.xy * 0.5 + 0.5 + vec2(sin(iTime * 4.0) * treb * 0.05, cos(iTime * 3.7) * treb * 0.05);
    vec3 base = texture(iChannel1, muv).rgb;

    vec3 light = normalize(vec3(0.4, 0.8, -0.3));
    float dif = max(dot(n, light), 0.0);
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);
    col = base * (0.4 + 0.7 * dif);
    col += vec3(0.24, 1.0, 0.9) * fres * (0.4 + bass * 0.8);
    col += vec3(1.0) * pow(dif, 28.0) * (0.3 + kick);
    // Bass kick brightness pump
    col *= 1.0 + kick * 0.6;
  } else {
    col += texture(iChannel1, uv * 0.3 + 0.5).rgb * (0.04 + bass * 0.06);
  }

  fragColor = vec4(col, 1.0);
}
