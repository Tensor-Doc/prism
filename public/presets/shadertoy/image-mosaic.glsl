// Image Mosaic — tessellated image tiles that pulse, scale, rotate on
// audio. Bass kicks flash all tiles white-hot; treble jitters individual
// cells. Original Prism v1.

mat2 rot(float a) { return mat2(cos(a), sin(a), -sin(a), cos(a)); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);

  float bass = 0.0;
  for (int i = 0; i < 12; i++) bass += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  bass /= 12.0;
  float treb = 0.0;
  for (int i = 48; i < 80; i++) treb += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  treb /= 32.0;
  float kick = bass * bass * 3.0;

  // Grid size pumps with bass (smaller cells = more detail on kicks)
  float grid = 6.0 + bass * 4.0 + kick * 2.0;
  vec2 cell = floor(p * grid);
  vec2 cellUV = fract(p * grid);
  float cellHash = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);

  // Tighten/loosen cells on bass; treble jitters
  cellUV = (cellUV - 0.5) * (0.85 - bass * 0.2 + kick * 0.15) + 0.5;
  cellUV += (vec2(fract(cellHash * 7.0), fract(cellHash * 13.0)) - 0.5) * treb * 0.08;

  // Rotate per-cell — kicks add a swivel jolt
  float ang = 0.1 * sin(iTime * 0.6 + cellHash * 6.28) + kick * (cellHash - 0.5) * 0.4;
  cellUV = rot(ang) * (cellUV - 0.5) + 0.5;

  vec3 col = texture(iChannel1, cellUV).rgb;

  // Cell brightness — strong bass pulse + per-cell strobe
  col *= 0.5 + bass * 1.2 + 0.25 * sin(iTime * 4.0 + cellHash * 10.0);

  // Kick flash — every cell whitens briefly
  col = mix(col, vec3(1.0), kick * 0.4);

  // Cell border darken + cyan/orange rim
  float frame = smoothstep(0.0, 0.04, cellUV.x) * smoothstep(0.0, 0.04, cellUV.y) *
                smoothstep(0.0, 0.04, 1.0 - cellUV.x) * smoothstep(0.0, 0.04, 1.0 - cellUV.y);
  col = mix(vec3(0.04, 0.05, 0.08), col, frame);
  vec3 rimCol = mix(vec3(0.24, 1.0, 0.9), vec3(1.0, 0.47, 0.28), cellHash);
  col += rimCol * (1.0 - frame) * (0.15 + bass * 0.4);

  fragColor = vec4(col, 1.0);
}
