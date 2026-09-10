/**
 * What a widget is allowed to do beyond drawing itself.
 *
 * A widget is a web page the user dropped in a folder, and until now the worst one could do
 * was skip a track. Reading the clipboard is a different class of thing: handing it to every
 * widget would mean a wallpaper shader could read a password you had just copied. So each
 * capability has to be asked for in `widget.json`, and the answer is checked in the main
 * process against the manifest of the *asking* window, which the renderer cannot influence.
 *
 * The check is `=== true`, not truthiness. `"clipboard": "false"` is a string, and a
 * truthy test would read it as a grant -- a permission that turns itself on when you try to
 * write it off is the worst possible direction for that mistake.
 *
 * An unknown capability name throws rather than returning false. A silent false would make
 * a typo in the host's own code look like a widget that had not asked, and the fix would be
 * looked for in the manifest.
 */

/**
 * Every capability a widget can ask for.
 *
 * `storage` is not a general write capability, and the distinction is the whole design.
 * There is no path parameter anywhere in it: the host resolves the asking widget's own id
 * to one file under `~/.hikari/state/`, so a widget cannot name a file and cannot reach
 * another widget's data because it cannot express another widget's name.
 */
const CAPABILITIES = new Set(["clipboard", "storage"]);

/**
 * @param {object | undefined} manifest  the asking widget's own manifest
 * @param {string} capability
 */
function granted(manifest, capability) {
  if (!CAPABILITIES.has(capability)) throw new Error(`unknown capability "${capability}"`);
  return manifest?.[capability] === true;
}

module.exports = { CAPABILITIES, granted };
