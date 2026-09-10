/**
 * What a changed file means.
 *
 * `fs.watch` on a widget root reports paths relative to that root, so a change arrives as
 * `clock/widget.json` or `shader/shaders/aurora.frag`. The two need different responses: a
 * manifest edit changes where the window goes and what it is allowed to do, so the host has
 * to re-discover; anything else is the page itself, and reloading that one window is enough.
 *
 * Pure, so the interesting part is tested without a filesystem or a running app. What is
 * left in the host is an `fs.watch` call and a debounce.
 */

const SEP = /[\\/]/;

/**
 * The widget folder a changed path belongs to, or null if it belongs to none.
 *
 * @param {string | null | undefined} relPath  path relative to a widget root
 * @returns {{folder: string, manifest: boolean} | null}
 */
function changed(relPath) {
  if (typeof relPath !== "string" || relPath.trim() === "") return null;

  const parts = relPath.split(SEP).filter((p) => p !== "" && p !== ".");
  // `..` anywhere means the path leaves the root, so it is not any widget's file. This is
  // not expected from fs.watch, and that is exactly why it is refused rather than trusted:
  // the value ends up selecting a window to reload.
  if (parts.some((p) => p === "..")) return null;

  // A file directly in the root, like the shared `theme.css`, belongs to no one widget.
  if (parts.length < 2) return null;

  return { folder: parts[0], manifest: parts[parts.length - 1] === "widget.json" };
}

module.exports = { changed };
