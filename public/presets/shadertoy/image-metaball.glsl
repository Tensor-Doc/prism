// Image Metaball — a single SDF blob whose surface samples the image via
// the surface normal (matcap-style), pulses with bass, gently rotated.
// Original Prism v1.

float sdSphere(vec3 p, float r) { return length(p) - r; }

// Smooth-min for blending if we want multiple later
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float scene(vec3 p, float aud) {
  // Slow wobble + audio breathing
  float r = 0.85 + aud * 0.3 + 0.08 * sin(iTime * 1.2);
  // Soft surface ripples
  float rip = 0.06 * sin(8.0 * p.x + iTime) * sin(8.0 * p.y + iTime * 1.3);
  return sdSphere(p, r) + rip * aud;
}

vec3 normal(vec3 p, float aud) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    scene(p + e.xyy, aud) - scene(p - e.xyy, aud),
    scene(p + e.yxy, aud) - scene(p - e.yxy, aud),
    scene(p + e.yyx, aud) - scene(p - e.yyx, aud)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  // Bass-band audio
  float bass = 0.0;
  for (int i = 0; i < 24; i++) {
    bass += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  }
  bass /= 24.0;

  vec3 ro = vec3(0.0, 0.0, -2.5);
  vec3 rd = normalize(vec3(uv, 1.4));

  // Rotate camera slowly
  float ct = cos(iTime * 0.15), st = sin(iTime * 0.15);
  ro.xz = mat2(ct, st, -st, ct) * ro.xz;
  rd.xz = mat2(ct, st, -st, ct) * rd.xz;

  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < 80; i++) {
    vec3 p = ro + rd * t;
    float d = scene(p, bass);
    if (d < 0.001) { hit = true; break; }
    if (t > 8.0) break;
    t += d;
  }

  vec3 col = vec3(0.03, 0.04, 0.07);
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = normal(p, bass);
    // Matcap-style image sampling: use normal as UV
    vec2 muv = n.xy * 0.5 + 0.5;
    vec3 base = texture(iChannel1, muv).rgb;

    // Light + rim
    vec3 light = normalize(vec3(0.4, 0.8, -0.3));
    float dif = max(dot(n, light), 0.0);
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);
    col = base * (0.4 + 0.7 * dif);
    col += vec3(0.24, 1.0, 0.9) * fres * 0.6;
    col += vec3(1.0) * pow(dif, 28.0) * 0.4;
    col *= 1.0 + bass * 0.3;
  } else {
    // Background: very dim, image-tinted
    col += texture(iChannel1, uv * 0.3 + 0.5).rgb * 0.04;
  }

  fragColor = vec4(col, 1.0);
}
