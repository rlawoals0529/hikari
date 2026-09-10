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
 * A CSS colour as a vec3 of 0..1 floats.
 *
 * This parsed only hex until it was pointed at a real palette. `getPropertyValue` on a
 * custom property returns the raw token text rather than a normalised colour, so
 * `--bg: hsl(247 24.4% 6.5%)` arrives verbatim, returned null, and every shader silently
 * fell back to its hardcoded ground while its accents came through fine. The result looked
 * deliberate, which is why nobody noticed.
 *
 * Null rather than a black fallback, on purpose: a palette that failed to parse should
 * surface as a fault, not render silently as the darkest colour available.
 */
function parseColour(input) {
  const text = String(input).trim();

  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  // Both the legacy comma form and the modern space-separated one. An alpha is parsed and
  // discarded, because a shader writes to an opaque surface.
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/i.exec(text);
  if (!fn) return null;
  const parts = fn[2].trim().split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  if (fn[1].toLowerCase().startsWith("rgb")) {
    const rgb = parts.slice(0, 3).map((p) => {
      const n = parseFloat(p);
      if (!Number.isFinite(n)) return null;
      // A percentage is out of 100, a bare number out of 255.
      return p.endsWith("%") ? n / 100 : n / 255;
    });
    return rgb.some((n) => n === null) ? null : rgb.map(clamp01);
  }

  const h = parseFloat(parts[0]);
  const s = parseFloat(parts[1]);
  const l = parseFloat(parts[2]);
  if (![h, s, l].every(Number.isFinite)) return null;
  return hslToRgb(((h % 360) + 360) % 360, clamp01(s / 100), clamp01(l / 100));
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** Hue in degrees, saturation and lightness as 0..1. */
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [clamp01(r1 + m), clamp01(g1 + m), clamp01(b1 + m)];
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

// Block-scoped so `api` is not a global. More than one of these files loads into the same
// page as a classic script -- the shader pulls in glsl and config, the companion mood and
// config -- and they share one global scope, so a second top-level `const api` is a
// redeclaration SyntaxError that discards the entire file. The symptom is an undefined
// `window.hikariGlsl` in a widget that never mentions `api`, which points nowhere near it.
{
  const api = { PRELUDE_LINES, parseColour, buildSource, remapErrors, formatErrors, uniformsFrom };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.hikariGlsl = api;
}
