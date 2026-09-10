// Contours — a topographic map of a field that is slowly rewriting itself.
//
// Lines are drawn where the height field crosses a level, using the field's own gradient
// to keep them one pixel wide at every slope. Without that correction the lines fatten
// wherever the terrain is flat, which is most of the frame.

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

float height(vec2 p, float t) {
  float sum = 0.0, amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * noise(p + vec2(t * 0.05 * float(i + 1), 0.0));
    p *= 2.03; amp *= 0.5;
  }
  return sum;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  uv.x *= u_resolution.x / u_resolution.y;
  float t = u_time * 0.35;

  // Load raises the terrain, so a busy machine has denser contours. It is the one reading
  // that belongs on a wallpaper: visible in peripheral vision, never demanding a look.
  float h = height(uv * 3.2, t) * (1.0 + u_cpu * 0.55);

  float levels = 15.0;
  float band = h * levels;
  // fwidth gives the field's rate of change at this pixel, which is exactly the width the
  // line needs to stay constant on screen.
  float line = abs(fract(band - 0.5) - 0.5) / fwidth(band);
  float ink = 1.0 - min(line, 1.0);

  // Every fifth contour is an index line, as on a real map.
  float index = step(0.5, fract(floor(band) / 5.0 + 0.001)) < 0.5 ? 1.0 : 0.45;

  vec3 col = mix(u_bg, u_bg * 1.35, h * 0.5);
  col += mix(u_accent2, u_accent, h) * ink * index * 0.85;

  // Same dither as the other gradients here: between two near-black colours an 8-bit
  // display has very few levels to work with, and the steps between them read as bands.
  col += (hash(gl_FragCoord.xy + fract(u_time)) - 0.5) * (1.0 / 255.0);

  fragColour = vec4(col, 1.0);
}
