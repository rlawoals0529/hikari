/**
 * Which stylesheets make up the theme, in the order they must be applied.
 *
 * This exists because every widget hardcodes `<link href="../theme.css">`, which resolves
 * relative to the widget's own folder. For a bundled widget that lands on
 * `widgets/theme.css` and works. For a widget in `~/.hikari/widgets/foo/` it lands on
 * `~/.hikari/widgets/theme.css`, which does not exist, so a third-party widget got no
 * theme at all and every `var()` silently fell back. The host injects these instead, so a
 * widget is themed wherever it lives.
 *
 * Three layers, and the order is the whole content of this function:
 *
 *   the base       the properties every widget reads, with their built-in values
 *   the palette    one of the vendored files, if the config picked one
 *   the user       `~/.hikari/theme.css`, which must win over a palette or picking a
 *                  palette would silently undo a hand-written override
 *
 * Only the base is required. A missing palette is the normal case, so is a missing user
 * layer, and neither is an error.
 */

/**
 * @param {string} baseCss  absolute path to the bundled theme
 * @param {string | null} paletteCss  absolute path to the chosen palette, or null
 * @param {string} userCss  absolute path to the user's optional override
 * @param {(p: string) => boolean} exists
 * @returns {string[]} paths to apply in order
 */
function themeSources(baseCss, paletteCss, userCss, exists) {
  const out = [];
  // A missing base is worth knowing about; a missing palette or user layer is not.
  if (exists(baseCss)) out.push(baseCss);
  if (paletteCss && exists(paletteCss)) out.push(paletteCss);
  if (exists(userCss)) out.push(userCss);
  return out;
}

module.exports = { themeSources };
