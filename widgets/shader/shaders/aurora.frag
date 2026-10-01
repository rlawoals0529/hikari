// Aurora: layered bands drifting on value noise.
//
// Three sheets at different speeds and scales. Depth comes from the parallax between
// them, not from a blur: a blurred copy of the same motion still reads as one flat layer.

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);                 // smoothstep, so the lattice does not show
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p) {
  float sum = 0.0, amp = 0.5;
  for (int i = 0; i < 5; i++) { sum += amp * noise(p); p *= 2.02; amp *= 0.5; }
  return sum;
}

// One sheet: a ribbon whose height wanders and whose brightness falls off away from it.
//
// The falloff has to be tight. A wide one turns three ribbons into a single wash, which is
// a gradient with extra steps: the eye needs to see an edge before it reads the thing as a
// curtain rather than as a colour.
float sheet(vec2 uv, float t, float scale, float drift, float centre) {
  float y = fbm(vec2(uv.x * scale + t * drift, t * 0.09)) - 0.5;
  float d = abs(uv.y - centre - y * 0.30);
  float core = exp(-d * d * 900.0);        // the visible edge
  float glow = exp(-d * d * 90.0) * 0.30;  // the light it throws, well below the core
  return core + glow;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float t = u_time * 0.06;

  // Loudness widens the curtain rather than brightening it. Brightness alone reads as a
  // flicker; a change in shape reads as the thing responding.
  float open = 1.0 + u_level * 0.9;

  // Separated in Y as well as in speed. Three ribbons on the same centre line stack into
  // one bright band no matter how tight each of them is.
  float a = sheet(uv, t,               1.4 * open,  0.30, 0.56);
  float b = sheet(uv, t * 1.31 + 11.0, 2.3 * open, -0.22, 0.44);
  float c = sheet(uv, t * 0.74 + 47.0, 3.7 * open,  0.16, 0.33);

  vec3 col = u_bg;
  col += u_accent  * a * 0.55;
  col += u_accent2 * b * 0.34;
  col += u_accent  * c * 0.18;

  // Bass lifts the floor slightly, so quiet passages settle rather than pump.
  col += u_bg * u_bass * 0.25;

  // Grain, for the same reason the CSS has it: a perfectly smooth gradient is what the
  // eye reads as machine-made, and it is where banding shows on an 8-bit display.
  col += (hash(gl_FragCoord.xy + fract(u_time)) - 0.5) * 0.012;

  fragColour = vec4(col, 1.0);
}
