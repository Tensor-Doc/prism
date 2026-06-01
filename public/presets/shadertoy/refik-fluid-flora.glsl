const float iAtlasSize = 4.0;

// Procedural 2D Hash
float hash(vec2 p) {
  p = fract(p * vec2(123.45, 678.91));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Value Noise
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// 2-Octave Fractional Brownian Motion
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 2; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

// Curl Noise for fluid-like divergence-free flow
vec2 curlNoise(vec2 p) {
  float e = 0.05;
  float n1 = fbm(p + vec2(e, 0.0));
  float n2 = fbm(p - vec2(e, 0.0));
  float n3 = fbm(p + vec2(0.0, e));
  float n4 = fbm(p - vec2(0.0, e));
  return vec2(n4 - n3, n1 - n2) / (2.0 * e);
}

// Rotates a 2D vector
mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// Safely samples a specific tile from the iChannel1 texture atlas
vec4 sampleAtlasTile(float k, vec2 uv) {
  float n = iAtlasSize > 0.0 ? floor(iAtlasSize) : 4.0;
  float col = floor(mod(k, n));
  float row = floor(k / n);
  // Clamp internal UV slightly to prevent edge bleeding between tiles
  vec2 clampedUV = clamp(uv, 0.005, 0.995);
  vec2 tileUV = (vec2(col, row) + clampedUV) / n;
  return texture(iChannel1, tileUV);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // Normalized coordinates
  vec2 uv = fragCoord / iResolution.xy;
  vec2 aspect_uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  // Single-pass audio fetch: x = bass, y = mid, z = treble
  vec3 audio = vec3(
    texture(iChannel0, vec2(0.05, 0.0)).r,
    texture(iChannel0, vec2(0.40, 0.0)).r,
    texture(iChannel0, vec2(0.80, 0.0)).r
  );

  // Vertical envelope to focus flora into a horizontal current
  float vertical_envelope = smoothstep(0.0, 0.25, uv.y) * smoothstep(1.0, 0.75, uv.y);

  // 1. Generate Flow Field
  vec2 flow_uv = aspect_uv * 1.2;
  flow_uv.y += iTime * 0.02; // Slow vertical drift in the flow field itself
  vec2 flow = curlNoise(flow_uv);

  // Apply flow distortion (Bass scales wave amplitude)
  float flow_strength = 0.12 + audio.x * 0.18;
  vec2 warped_uv = aspect_uv + flow * flow_strength;

  // Horizontal drift (Mid scales flow velocity)
  float drift_speed = 0.15 + audio.y * 0.35;
  warped_uv.x -= iTime * drift_speed;

  // Subtle vertical undulation
  warped_uv.y += sin(warped_uv.x * 2.5 + iTime * 0.8) * (0.04 + audio.x * 0.08);

  // 2. Setup Background (Dark, warm gallery-grade gradient with vignette)
  vec3 bg = mix(vec3(0.015, 0.01, 0.008), vec3(0.04, 0.025, 0.018), uv.y * (1.0 - uv.x));
  float vignette = uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y);
  bg *= 0.5 + 0.5 * pow(16.0 * vignette, 0.25);

  // 3. Layer Accumulation (Staggered Fibonacci-like scales to prevent grid patterns)
  vec3 fluid_col = vec3(0.0);
  float total_alpha = 0.0;
  float scales[5] = float[](2.5, 4.0, 6.5, 10.0, 16.0);

  // Ambient Soft Base (5 Layers)
  for (int i = 0; i < 5; i++) {
    float scale = scales[i];
    
    // Jitter layer translation to break spatial alignment
    vec2 l_uv = warped_uv * scale + hash(vec2(scale, float(i))) * 42.19;
    
    vec2 ip = floor(l_uv);
    vec2 fp = fract(l_uv);

    // Jitter tile center to completely eliminate grid mosaic look
    vec2 center = vec2(0.5) + (vec2(hash(ip), hash(ip + 45.32)) * 2.0 - 1.0) * 0.15;

    // Calculate distance to soft tile boundary
    float dist = length(fp - center);
    float mask = smoothstep(0.65, 0.15, dist); // Wide, painterly soft footprint

    if (mask > 0.01) {
      // Deterministically select a tile from the atlas
      float h = hash(ip * 7.31);
      float tile_idx = floor(h * (iAtlasSize * iAtlasSize));

      // Map local coordinates to normalized tile space [0, 1]
      vec2 tile_uv = (fp - center) + 0.5;

      // Rotate tile based on time and treble
      float angle = h * 6.2831 + iTime * (0.05 + audio.z * 0.15);
      float c = cos(angle), s = sin(angle);
      mat2 r = mat2(c, -s, s, c);
      tile_uv = r * (tile_uv - 0.5) + 0.5;

      // Sample atlas
      vec4 tex = sampleAtlasTile(tile_idx, tile_uv);

      // Painterly desaturation (60% toward luminance for gallery aesthetic)
      float luma = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
      vec3 muted = mix(tex.rgb, vec3(luma), 0.6);

      // Subtle luminous accent (soft glow on bright botanical highlights)
      muted += vec3(0.12, 0.08, 0.05) * smoothstep(0.5, 0.9, luma) * (1.0 + audio.x);

      // Accumulate with low alpha weight to build up density softly, shaped by the vertical envelope
      float weight = mask * 0.25 * vertical_envelope;
      fluid_col += muted * weight;
      total_alpha += weight;
    }
  }

  // 4. Foreground Layer (Readable, dominant directional flow, spotlight highlights)
  float fg_scale = 3.8; // Medium-sized tiles (~10-15% of canvas width)
  vec2 fg_warped_uv = aspect_uv + flow * 0.03; // Muted curl noise for readable flow structure
  fg_warped_uv.x -= iTime * 0.35; // Dominant horizontal drift
  fg_warped_uv.y += sin(fg_warped_uv.x * 2.5 + iTime * 0.8) * (0.04 + audio.x * 0.08);

  vec2 fg_l_uv = fg_warped_uv * fg_scale + hash(vec2(fg_scale, 5.0)) * 42.19;
  vec2 fg_ip = floor(fg_l_uv);
  vec2 fg_fp = fract(fg_l_uv);

  vec2 fg_center = vec2(0.5) + (vec2(hash(fg_ip), hash(fg_ip + 45.32)) * 2.0 - 1.0) * 0.15;
  float fg_dist = length(fg_fp - fg_center);
  float fg_mask = smoothstep(0.55, 0.25, fg_dist); // Slightly sharper mask for readability

  if (fg_mask > 0.01) {
    float fg_h = hash(fg_ip * 7.31);
    float fg_tile_idx = floor(fg_h * (iAtlasSize * iAtlasSize));
    vec2 fg_tile_uv = (fg_fp - fg_center) + 0.5;

    // Rotate tile based on time and treble
    float fg_angle = fg_h * 6.2831 + iTime * (0.05 + audio.z * 0.15);
    float fg_c = cos(fg_angle), fg_s = sin(fg_angle);
    mat2 fg_r = mat2(fg_c, -fg_s, fg_s, fg_c);
    fg_tile_uv = fg_r * (fg_tile_uv - 0.5) + 0.5;

    // Sample atlas
    vec4 fg_tex = sampleAtlasTile(fg_tile_idx, fg_tile_uv);

    // Painterly desaturation (60% toward luminance)
    float fg_luma = dot(fg_tex.rgb, vec3(0.299, 0.587, 0.114));
    vec3 fg_muted = mix(fg_tex.rgb, vec3(fg_luma), 0.6);

    // Luminous spotlights on ~8% of foreground tiles (rare but strong gallery highlights)
    float spot_hash = hash(fg_ip * 13.37 + 19.84);
    if (spot_hash > 0.92) {
      fg_muted *= vec3(2.2, 1.6, 0.9);
    }

    // Subtle luminous accent (soft glow on bright highlights)
    fg_muted += vec3(0.12, 0.08, 0.05) * smoothstep(0.5, 0.9, fg_luma) * (1.0 + audio.x);

    // Accumulate with slightly stronger weight to anchor the foreground, shaped by the vertical envelope
    float fg_weight = fg_mask * 0.35 * vertical_envelope;
    fluid_col += fg_muted * fg_weight;
    total_alpha += fg_weight;
  }

  // Normalize accumulated color to prevent over-exposure
  if (total_alpha > 0.0) {
    fluid_col /= total_alpha;
  }

  // 5. Final Blend (Cap the fluid alpha to ensure background remains visible)
  float final_blend = min(total_alpha, 0.65);
  vec3 col = mix(bg, fluid_col, final_blend);

  // Output non-transparent color
  fragColor = vec4(col, 1.0);
}