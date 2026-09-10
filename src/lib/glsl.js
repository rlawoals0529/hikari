/**
 * The parts of running a shader that are just data, kept out of the renderer so they can
 * be tested without a GPU.
 *
 * Nothing here touches WebGL. `node --test` requires it; a widget loads the same file with
 * a script tag and reads it off `window`. One copy, so the two cannot drift.
 */

/* The lines every shader gets for free. Its length is also how far out every compile
   error is, which is why the count is exported rather than written down twice. */
const PRELUDE = `#version 300 es
precision highp float;

out vec4 fragColour;

uniform vec2  u_resolution;
uniform float u_time;
uniform vec2  u_mouse;      // 0..1 across the surface, (-1,-1) until the pointer moves
uniform float u_bass;       // 0..1, smoothed
uniform float u_level;      // 0..1 whole-spectrum loudness, smoothed
uniform float u_cpu;        // 0..1
uniform vec3  u_bg;         // the palette's ground
uniform vec3  u_accent;
uniform vec3  u_accent2;
`;

const PRELUDE_LINES = PRELUDE.split("\n").length - 1;

/**
 * A hex colour as a vec3 of 0..1 floats.
 *
 * Null rather than a black fallback, on purpose: a palette that failed to parse should
 * surface as a fault, not render silently as the darkest colour available.
 */
function hexToVec3(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * The full source handed to the driver: the prelude, then the shader as written.
 *
 * No separator between them. PRELUDE already ends in a newline, so adding another would
 * put a blank line in front of the shader and every reported line would be one further out
 * than PRELUDE_LINES says. That is not hypothetical: it is what this did.
 */
function buildSource(body) {
  return PRELUDE + body;
}

/**
 * Rewrite a driver's compile log so its line numbers point at the shader you wrote.
 *
 * Drivers count lines in the source they were given, and that includes the prelude, so
 * every number is out by its length. An error on line 3 of a 12 line shader is reported
 * as line 21, and looking for line 21 of a 12 line file is how a one character typo turns
 * into an evening.
 */
function remapErrors(log, preludeLines) {
  const offset = Number.isFinite(preludeLines) ? preludeLines : PRELUDE_LINES;
  if (!log) return [];
  return String(log)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // The two driver families: "ERROR: 0:21: 'x' : msg" and "0(21) : error C0000: msg".
      const angle = /^(\w+):\s*\d+:(\d+):\s*(.*)$/.exec(line);
      const paren = /^\d+\((\d+)\)\s*:\s*(.*)$/.exec(line);
      if (angle) {
        const at = Number(angle[2]) - offset;
        return { line: at > 0 ? at : null, severity: angle[1].toLowerCase(), message: angle[3] };
      }
      if (paren) {
        const at = Number(paren[1]) - offset;
        return { line: at > 0 ? at : null, severity: "error", message: paren[2] };
      }
      // Anything unrecognised is still shown. Dropping it would hide the one line that
      // explains the rest.
      return { line: null, severity: "error", message: line };
    });
}

/** One line per problem, carrying the shader's own line number. For drawing on the canvas. */
function formatErrors(errors, name) {
  const label = name || "shader";
  if (!errors || !errors.length) return "";
  return errors.map((e) => `${label}${e.line ? ":" + e.line : ""}  ${e.message}`).join("\n");
}

/**
 * Every uniform the renderer sets, derived in one place so the mapping from provider
 * output to shader input is a single testable function rather than a scatter of reads.
 */
function uniformsFrom(state, audio, view) {
  const s = state || {}, a = audio || {}, v = view || {};
  const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
  return {
    u_time: Number.isFinite(v.time) ? v.time : 0,
    u_resolution: [v.width || 1, v.height || 1],
    // Never moved is (-1,-1), not (0,0): a shader that brightens under the cursor must not
    // brighten the top-left corner of a wallpaper nobody has touched.
    u_mouse: v.mouse ? [clamp01(v.mouse[0]), clamp01(v.mouse[1])] : [-1, -1],
    u_bass: clamp01(a.bass),
    u_level: clamp01(a.level),
    u_cpu: clamp01((s.cpu && s.cpu.usage) / 100),
  };
}

const api = { PRELUDE_LINES, hexToVec3, buildSource, remapErrors, formatErrors, uniformsFrom };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.hikariGlsl = api;
