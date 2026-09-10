const { test } = require("node:test");
const assert = require("node:assert");
const {
  PRELUDE_LINES, parseColour, buildSource, remapErrors, formatErrors, uniformsFrom,
} = require("../src/lib/glsl.js");

test("parseColour reads hex in both long and short form", () => {
  assert.deepStrictEqual(parseColour("#ffffff"), [1, 1, 1]);
  assert.deepStrictEqual(parseColour("000000"), [0, 0, 0]);
  assert.deepStrictEqual(parseColour("#fff"), [1, 1, 1]);
  assert.deepStrictEqual(parseColour("  #FF0000 "), [1, 0, 0]);
});

test("a colour it cannot read is null, never black", () => {
  // Black is a colour a palette might legitimately want, so it cannot double as the
  // failure value. Silently rendering an unparsed palette as black is the bug.
  for (const bad of ["", "nope", "#12345", "#gggggg", null, undefined, "hsl(1 2)", "oklch(0.5 0.1 200)"]) {
    assert.strictEqual(parseColour(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("it reads the hsl() a real palette actually emits", () => {
  // This is the bug that made the fix necessary. getPropertyValue on a custom property
  // returns the raw token text, not a normalised colour, so a palette written as hsl()
  // arrived verbatim, parsed as null, and every shader fell back to its hardcoded ground
  // while its accents came through correctly. It looked deliberate.
  const bg = parseColour("hsl(247 24.4% 6.5%)");
  assert.ok(bg, "a palette ground written as hsl must parse");
  const [r, g, b] = bg;
  // A dark violet: blue leads, red beats green, and all of it is near the floor.
  assert.ok(b > r && r > g, `expected a violet, got ${bg.join(", ")}`);
  assert.ok(Math.max(r, g, b) < 0.1, "6.5% lightness must stay near black");
});

test("hsl and rgb agree on a colour with a known answer", () => {
  // Pure red, expressed three ways. Pinned against an external fact rather than against
  // each other, since two wrong conversions can agree.
  for (const red of ["hsl(0, 100%, 50%)", "rgb(255, 0, 0)", "rgb(255 0 0)", "rgb(100%, 0%, 0%)"]) {
    assert.deepStrictEqual(parseColour(red), [1, 0, 0], red);
  }
});

test("an alpha is accepted and discarded, because a shader surface is opaque", () => {
  assert.deepStrictEqual(parseColour("hsla(120 100% 25% / 0.5)"), parseColour("hsl(120 100% 25%)"));
  assert.deepStrictEqual(parseColour("rgba(255, 0, 0, 0.3)"), [1, 0, 0]);
});

test("a hue outside 0..360 wraps rather than clamping", () => {
  // 480 is 120 and -120 is 240. Clamping would silently turn a wrapped hue into a
  // different colour instead of the one asked for.
  assert.deepStrictEqual(parseColour("hsl(480 100% 50%)"), parseColour("hsl(120 100% 50%)"));
  assert.deepStrictEqual(parseColour("hsl(-120 100% 50%)"), parseColour("hsl(240 100% 50%)"));
});

test("a shader's first line lands exactly PRELUDE_LINES into the built source", () => {
  // The offset remapErrors subtracts has to be the offset buildSource actually introduces.
  // Deriving it from the built source rather than restating the arithmetic is the point:
  // an earlier version of this test asserted the same sum the code used, so the two agreed
  // with each other and both were one line out from the file on disk.
  const marker = "void main() { fragColour = vec4(1.0); }";
  const lines = buildSource(marker).split("\n");
  const oneBased = lines.indexOf(marker) + 1;
  assert.strictEqual(oneBased - PRELUDE_LINES, 1, "shader line 1 must map to prelude + 1");
});

test("a driver error on the built source maps back to the file's own line", () => {
  // End to end through both functions, on a shader whose lines we know.
  const shader = ["// one", "// two", "void main() {", "  fragColour = vec4(nope, 1.0);", "}"].join("\n");
  const built = buildSource(shader);
  const badLine = built.split("\n").findIndex((l) => l.includes("nope")) + 1;
  const [e] = remapErrors(`ERROR: 0:${badLine}: 'nope' : undeclared identifier`);
  assert.strictEqual(e.line, 4, "the mistake is on line 4 of the shader as written");
});

test("compile errors are reported against the shader's own lines", () => {
  // The driver saw line 17; the prelude is 14 lines plus the blank joiner, so the shader
  // author needs to look at line 2.
  const log = `ERROR: 0:${PRELUDE_LINES + 2}: 'foo' : undeclared identifier`;
  assert.deepStrictEqual(remapErrors(log), [
    { line: 2, severity: "error", message: "'foo' : undeclared identifier" },
  ]);
});

test("the other driver's error format is understood too", () => {
  const log = `0(${PRELUDE_LINES + 5}) : error C1503: undefined variable "bass"`;
  const [e] = remapErrors(log);
  assert.strictEqual(e.line, 5);
  assert.match(e.message, /undefined variable/);
});

test("an error inside the prelude reports no line rather than a negative one", () => {
  const [e] = remapErrors("ERROR: 0:3: something in the prelude");
  assert.strictEqual(e.line, null);
  assert.strictEqual(e.message, "something in the prelude");
});

test("a line it cannot parse is still shown", () => {
  // Dropping the unrecognised line is how you lose the one sentence that explains the rest.
  const [e] = remapErrors("Fragment shader failed to compile");
  assert.strictEqual(e.line, null);
  assert.strictEqual(e.message, "Fragment shader failed to compile");
});

test("empty and missing logs produce no errors", () => {
  assert.deepStrictEqual(remapErrors(""), []);
  assert.deepStrictEqual(remapErrors(null), []);
  assert.deepStrictEqual(remapErrors(undefined), []);
});

test("formatErrors names the shader and the line", () => {
  const out = formatErrors(remapErrors(`ERROR: 0:${PRELUDE_LINES + 4}: bad`), "aurora");
  assert.strictEqual(out, "aurora:4  bad");
  assert.strictEqual(formatErrors([], "aurora"), "");
});

test("uniforms are clamped and scaled from provider output", () => {
  const u = uniformsFrom(
    { cpu: { usage: 55 } },
    { bass: 0.4, level: 1.9 },
    { time: 12.5, width: 800, height: 600, mouse: [0.25, 0.75] },
  );
  assert.strictEqual(u.u_time, 12.5);
  assert.deepStrictEqual(u.u_resolution, [800, 600]);
  assert.deepStrictEqual(u.u_mouse, [0.25, 0.75]);
  assert.strictEqual(u.u_bass, 0.4);
  assert.strictEqual(u.u_level, 1, "out of range loudness clamps rather than blowing up");
  assert.strictEqual(u.u_cpu, 0.55);
});

test("an untouched pointer is off-surface, not the corner", () => {
  // (0,0) is a real position a shader would react to. "Never moved" has to be a value
  // no pointer can hold.
  assert.deepStrictEqual(uniformsFrom({}, {}, {}).u_mouse, [-1, -1]);
});

test("missing state gives usable zeroes rather than NaN", () => {
  const u = uniformsFrom(undefined, undefined, undefined);
  assert.strictEqual(u.u_cpu, 0);
  assert.strictEqual(u.u_bass, 0);
  assert.strictEqual(u.u_time, 0);
  // A zero-sized resolution divides by zero in almost every shader ever written.
  assert.deepStrictEqual(u.u_resolution, [1, 1]);
});
