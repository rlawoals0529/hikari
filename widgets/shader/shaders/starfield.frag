// Starfield: three parallax layers of drifting points.
//
// Stars are placed by hashing cell coordinates rather than stored, so the field is
// endless and costs no memory. Each layer moves at its own rate; that difference is the
// only thing creating depth here.

float hash21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
vec2  hash22(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)),
                                             dot(p, vec2(269.5, 183.3)))) * 43758.5453); }

float layer(vec2 uv, float density, float speed, float size, float t) {
  uv.x += t * speed;
  vec2 cell = floor(uv * density);
  vec2 pos = hash22(cell);
  // Not every cell gets a star, or the field becomes a grid.
  if (hash21(cell + 3.7) > 0.55) return 0.0;

  float d = length(fract(uv * density) - pos);
  // Twinkle at a rate that differs per star, so they do not pulse in unison.
  float phase = hash21(cell + 9.1) * 6.2831;
  float twinkle = 0.65 + 0.35 * sin(t * 1.7 + phase);
  return smoothstep(size, 0.0, d) * twinkle;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  uv.x *= u_resolution.x / u_resolution.y;     // square cells on any aspect ratio
  float t = u_time * 0.05;

  // Bass pushes the near layer only. Moving all three together looks like a zoom, not
  // like depth.
  float near = 1.0 + u_bass * 0.6;

  float s = layer(uv, 9.0,  0.30, 0.055 * near, t) * 1.00
          + layer(uv, 18.0, 0.16, 0.035,        t) * 0.55
          + layer(uv, 34.0, 0.07, 0.022,        t) * 0.30;

  // A faint gradient so the sky is not a flat field with dots on it.
  vec3 col = u_bg + u_accent2 * pow(1.0 - uv.y, 3.0) * 0.10;
  col += mix(u_accent, vec3(1.0), 0.35) * s;

  // Under the cursor, a little more of the sky shows. Skipped entirely until the pointer
  // has actually moved, which the host signals as (-1,-1).
  if (u_mouse.x >= 0.0) {
    vec2 m = u_mouse; m.x *= u_resolution.x / u_resolution.y;
    col += u_accent * exp(-length(uv - m) * 7.0) * 0.16;
  }

  // Dither. The sky gradient runs between two near-black colours and an 8-bit display has
  // barely a dozen levels across it, so without this it steps into visible bands.
  col += (hash21(gl_FragCoord.xy + fract(u_time)) - 0.5) * (1.0 / 255.0);

  fragColour = vec4(col, 1.0);
}
