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
 * The user layer comes second so it overrides, and it is optional: a missing file is the
 * normal case, not an error.
 */

/**
 * @param {string} baseCss  absolute path to the bundled theme
 * @param {string} userCss  absolute path to the user's optional override
 * @param {(p: string) => boolean} exists
 * @returns {string[]} paths to apply in order
 */
function themeSources(baseCss, userCss, exists) {
  const out = [];
  // A missing base is worth knowing about; a missing user layer is not.
  if (exists(baseCss)) out.push(baseCss);
  if (exists(userCss)) out.push(userCss);
  return out;
}

module.exports = { themeSources };
