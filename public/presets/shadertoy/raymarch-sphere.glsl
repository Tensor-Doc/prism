// Raymarch Sphere — minimal SDF raymarcher: a sphere with a Mandelbox-ish
// fold pattern, lit + rotated by time, audio modulates the iteration count.
// Original Prism v1.

float sdSphere(vec3 p, float r) { return length(p) - r; }
float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sceneSDF(vec3 p, float aud) {
  // Fold space (kaleidoscope-like)
  p.xz *= mat2(cos(iTime * 0.2), sin(iTime * 0.2), -sin(iTime * 0.2), cos(iTime * 0.2));
  for (int i = 0; i < 4; i++) {
    p = abs(p) - vec3(0.7);
    p.xy *= mat2(0.8, 0.6, -0.6, 0.8);
  }
  float s = sdSphere(p, 0.55 + aud * 0.25);
  float b = sdBox(p, vec3(0.4));
  return mix(s, b, 0.5 + 0.5 * sin(iTime * 0.5));
}

vec3 normal(vec3 p, float aud) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    sceneSDF(p + e.xyy, aud) - sceneSDF(p - e.xyy, aud),
    sceneSDF(p + e.yxy, aud) - sceneSDF(p - e.yxy, aud),
    sceneSDF(p + e.yyx, aud) - sceneSDF(p - e.yyx, aud)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  // Audio amplitude (mid band)
  float aud = 0.0;
  for (int i = 8; i < 48; i++) {
    aud += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  }
  aud /= 40.0;

  vec3 ro = vec3(0.0, 0.0, -3.0);
  vec3 rd = normalize(vec3(uv, 1.4));

  float t = 0.0;
  for (int i = 0; i < 64; i++) {
    vec3 p = ro + rd * t;
    float d = sceneSDF(p, aud);
    if (d < 0.001 || t > 8.0) break;
    t += d;
  }

  vec3 col = vec3(0.03, 0.04, 0.07);
  if (t < 8.0) {
    vec3 p = ro + rd * t;
    vec3 n = normal(p, aud);
    vec3 light = normalize(vec3(0.5, 0.8, -0.5));
    float dif = max(dot(n, light), 0.0);
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 2.0);
    // Brand-tinted shading
    vec3 base = mix(vec3(0.18, 0.45, 0.55), vec3(0.95, 0.45, 0.20), n.x * 0.5 + 0.5);
    col = base * (0.25 + 0.75 * dif);
    col += vec3(0.24, 1.0, 0.9) * fres * 0.5; // cyan rim
    col += vec3(1.0) * pow(dif, 32.0) * 0.4;  // spec
    col *= 1.0 + aud * 0.4;                    // audio brightness
  }

  fragColor = vec4(col, 1.0);
}
