// Rain: drops running down a pane, with the streak each one leaves behind.
//
// The trail is the whole effect. A drop without one is a moving dot; the tapering streak
// above it is what the eye reads as water on glass.

float hash21(vec2 p) { return fract(sin(dot(p, vec2(23.7, 91.3))) * 43758.5453); }

// One column of drops. Returns brightness at this point.
float column(vec2 uv, float t, float seed) {
  float speed = 0.35 + hash21(vec2(seed, 1.0)) * 0.55;
  float phase = hash21(vec2(seed, 7.0));
  float y = fract(uv.y + t * speed + phase);   // the drop's own position in the column

  float head = smoothstep(0.030, 0.0, length(vec2(uv.x, (y - 0.5) * 1.6)));
  // The trail only exists above the head, and thins as it goes.
  float above = max(0.0, y - 0.5);
  float trail = smoothstep(0.012, 0.0, abs(uv.x)) * exp(-above * 16.0) * step(0.5, y);

  return head + trail * 0.55;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float t = u_time * 0.12;

  // Heavier rain when it is louder: more columns rather than faster drops, because
  // speeding the same drops up just looks like the video is playing wrong.
  float columns = mix(26.0, 44.0, u_level);

  float x = uv.x * columns;
  float id = floor(x);
  vec2 cell = vec2(fract(x) - 0.5, uv.y);

  float v = column(cell, t, id);
  // Neighbouring columns, so a drop near an edge is not clipped in half.
  v += column(vec2(cell.x - 1.0, uv.y), t, id + 1.0) * 0.9;
  v += column(vec2(cell.x + 1.0, uv.y), t, id - 1.0) * 0.9;

  // The pane itself: darker at the top where the light does not reach.
  vec3 col = mix(u_bg * 0.82, u_bg, uv.y);
  col += mix(u_accent2, u_accent, uv.y) * v * 0.85;
  col += u_accent * u_bass * 0.05;

  // Dither. A gradient between two near-black colours crosses only a handful of 8-bit
  // levels, so it posterises into visible horizontal bands. A little noise below one level
  // scatters the boundary and the banding stops being a line.
  col += (hash21(gl_FragCoord.xy + fract(u_time)) - 0.5) * (1.0 / 255.0);

  fragColour = vec4(col, 1.0);
}
