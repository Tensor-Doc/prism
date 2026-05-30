// Image Mosaic — tessellated image tiles that scale + rotate + offset on
// audio beats. Each cell shows the same image; bass drives a global beat
// burst; treble jitters individual cells. Original Prism v1.

mat2 rot(float a) { return mat2(cos(a), sin(a), -sin(a), cos(a)); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);

  // Audio bands
  float bass = 0.0;
  for (int i = 0; i < 12; i++) {
    bass += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  }
  bass /= 12.0;
  float treb = 0.0;
  for (int i = 48; i < 80; i++) {
    treb += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  }
  treb /= 32.0;

  // Grid size, pulsing on bass
  float grid = mix(6.0, 9.0, 0.5 + 0.5 * sin(iTime * 0.4)) + bass * 1.5;
  vec2 cell = floor(p * grid);
  vec2 cellUV = fract(p * grid);

  // Per-cell jitter offset, treble adds chaos
  float cellHash = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
  cellUV = (cellUV - 0.5) * (0.9 - bass * 0.15) + 0.5;
  cellUV += (vec2(fract(cellHash * 7.0), fract(cellHash * 13.0)) - 0.5) * treb * 0.04;

  // Rotate per-cell on a slow phase
  float ang = 0.08 * sin(iTime * 0.6 + cellHash * 6.28);
  cellUV = rot(ang) * (cellUV - 0.5) + 0.5;

  // Sample image
  vec3 col = texture(iChannel1, cellUV).rgb;

  // Brightness pulses with beat
  col *= 0.7 + 0.7 * bass + 0.15 * sin(iTime * 4.0 + cellHash * 10.0);

  // Cyan/orange edge frame around each cell
  float frame = smoothstep(0.0, 0.03, cellUV.x) * smoothstep(0.0, 0.03, cellUV.y) *
                smoothstep(0.0, 0.03, 1.0 - cellUV.x) * smoothstep(0.0, 0.03, 1.0 - cellUV.y);
  col = mix(vec3(0.04, 0.05, 0.08), col, frame);
  // Cyan rim glow on the inside of frames
  vec3 rimCol = mix(vec3(0.24, 1.0, 0.9), vec3(1.0, 0.47, 0.28), cellHash);
  col += rimCol * (1.0 - frame) * 0.15;

  fragColor = vec4(col, 1.0);
}
