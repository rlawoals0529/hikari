/**
 * Where a setting comes from, and who wins.
 *
 * A widget's settings arrive from three places and they are layered in this order:
 *
 *   1. `widget.json`                 -- the widget author's defaults
 *   2. `~/.hikari/config.json`       -- the user's overrides, per widget id
 *   3. a live edit                   -- the settings overlay, or an edit to that file
 *
 * The point of the middle layer is that customising never edits a tracked file. Changing
 * a widget's position used to mean editing `widgets/clock/widget.json`, which conflicts on
 * every pull; now it means writing one key into a file git has never heard of.
 *
 * All of this is pure so it can be tested without Electron, and so the browser preview can
 * reuse the same merge instead of growing its own.
 */

const MIN_INTERVAL_MS = 250;

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Later layers win, one key at a time. Plain objects merge; arrays replace whole.
 *
 * An array replaces rather than concatenating because every array here is a *list the user
 * chose* -- dock entries, shortcut bindings, a palette. Concatenating would make removing a
 * default entry impossible, which is the one thing an override has to be able to do.
 *
 * A key that is present wins even when its value is null, so `{"source": null}` clears a
 * default. Absence is the only way to say "leave it alone".
 */
function merge(base, over) {
  if (!isPlain(over)) return over === undefined ? base : over;
  if (!isPlain(base)) return { ...over };
  const out = { ...base };
  for (const k of Object.keys(over)) {
    // An object always goes through merge, even when the base has no such key, so the
    // result never aliases a nested object inside the override. Handing a widget a live
    // reference into ~/.hikari/config.json means one careless write edits the user's own
    // settings in memory, and the next widget to read them sees the change.
    out[k] = isPlain(over[k]) ? merge(isPlain(base[k]) ? base[k] : {}, over[k]) : over[k];
  }
  return out;
}

/**
 * A query-string value as the type it looks like.
 *
 * The preview drives widgets through the URL, where everything is a string, while the host
 * drives them through JSON, where `fps` is a number and `showLabel` is a boolean. Without
 * this, `?showLabel=false` reads as the truthy string "false" and the label stays on -- the
 * preview would disagree with the desktop about the same setting, which makes it useless as
 * a preview.
 *
 * A bare key (`?demo`) is `true`, because that is what writing it means.
 */
function coerce(text) {
  if (text === "" || text === null) return true;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  // Only a complete, finite number. "3 kg" and "1e999" stay strings rather than becoming
  // NaN and Infinity, either of which would reach a widget as a number and render as one.
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return text;
}

/** A whole query string as a config object. Repeated keys become an array. */
function fromQuery(search) {
  const out = {};
  for (const [k, v] of new URLSearchParams(search ?? "")) {
    const val = coerce(v);
    if (k in out) out[k] = Array.isArray(out[k]) ? [...out[k], val] : [out[k], val];
    else out[k] = val;
  }
  return out;
}

/** The three layers, resolved. `live` is a single widget's edits, not the whole file. */
function widgetConfig(manifest, userConfig, id, live) {
  const overrides = (userConfig && userConfig.widgets && userConfig.widgets[id]) ?? {};
  return merge(merge(manifest ?? {}, overrides), live ?? {});
}

/**
 * A provider's own defaults with the user's `providers.<name>` block over the top.
 *
 * Providers are polled once for every widget, so their settings cannot come from a widget
 * manifest -- there is no single widget to ask. They come from the user config only.
 */
function providerConfig(provider, userConfig) {
  const overrides = (userConfig && userConfig.providers && userConfig.providers[provider.name]) ?? {};
  return merge(provider.defaults ?? {}, overrides);
}

/**
 * How often to poll, floored.
 *
 * A typo of `"intervalMs": 1` would spin a core forever running an AppleScript, and the
 * symptom -- a hot fan -- points nowhere near the config file that caused it. The floor is
 * a quarter second: faster than anything a human reads off a widget, slower than a spin.
 */
function providerInterval(provider, config) {
  const wanted = Number(config && config.intervalMs);
  if (!Number.isFinite(wanted) || wanted <= 0) return provider.intervalMs;
  return Math.max(MIN_INTERVAL_MS, Math.round(wanted));
}

// Block-scoped so `api` is not a global. More than one of these files loads into the same
// page as a classic script -- the shader pulls in glsl and config, the companion mood and
// config -- and they share one global scope, so a second top-level `const api` is a
// redeclaration SyntaxError that discards the entire file. The symptom is an undefined
// `window.hikariGlsl` in a widget that never mentions `api`, which points nowhere near it.
{
  const api = { MIN_INTERVAL_MS, merge, coerce, fromQuery, widgetConfig, providerConfig, providerInterval };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.hikariConfig = api;
}
