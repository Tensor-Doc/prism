// Tunnel of Images — classic polar-mapped cylindrical tunnel with an
// image wrapped around the inside, bass-driven flight speed, cyan/orange
// edge glow. Original Prism v1.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 p = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  // Bass band — drives forward speed + tunnel breathing.
  float bass = 0.0;
  for (int i = 0; i < 16; i++) {
    bass += texture(iChannel0, vec2(float(i) / 256.0, 0.5)).x;
  }
  bass /= 16.0;

  // Slow winding sway so the tunnel snakes rather than going straight.
  vec2 center = vec2(0.18 * sin(iTime * 0.27), 0.18 * cos(iTime * 0.31));
  vec2 q = p - center;
  float r = length(q);
  float a = atan(q.y, q.x);

  // Cylindrical UV: angle wraps horizontally, depth scrolls forward.
  float speed = 0.55 + bass * 1.4;
  float depth = 1.0 / max(r, 0.001) + iTime * speed;
  vec2 uv = vec2(a / 6.28318, depth);

  // Sample the image; brighten + tint slightly with depth for atmospheric perspective.
  vec3 col = texture(iChannel1, uv).rgb;
  float fog = exp(-r * 1.4);
  col *= 0.4 + 0.7 * fog;

  // Cyan rim near the tunnel mouth (center bright); orange decay at edges.
  float rim = smoothstep(0.0, 0.7, fog);
  col += vec3(0.24, 1.0, 0.9) * rim * 0.25 * (0.4 + bass);
  col = mix(col, col + vec3(1.0, 0.47, 0.28) * 0.1, smoothstep(0.5, 1.5, r));

  // Subtle vignette
  col *= 1.0 - 0.5 * smoothstep(0.5, 1.0, length(p));

  fragColor = vec4(col, 1.0);
}
