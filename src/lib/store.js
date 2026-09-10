/**
 * Where a widget's own state goes, and everything it is not allowed to do.
 *
 * Until now the worst a widget could do was skip a track and read the clipboard. Writing a
 * file is a different class again, and the design that suggests itself first is the wrong
 * one: an IPC call that takes a path. That hands every widget the ability to write anywhere
 * the app can reach, which for a wallpaper shader is an absurd amount of authority.
 *
 * So **a widget never names a file.** It calls `get()` and `set(value)`, and the host
 * resolves *its own id* to one path under `~/.hikari/state/`. There is no parameter for a
 * path, so there is nothing to traverse out of, and one widget cannot reach another's data
 * because it cannot express another's name.
 *
 * The id still has to be checked, because it comes from a `widget.json` and a folder name,
 * and a folder called `../../.ssh` is a thing a person can make. Everything below is that
 * check and its consequences, which is why this file is mostly refusals.
 */
const path = require("node:path");

/**
 * What a widget id may look like.
 *
 * An allowlist, not a denylist. A denylist here would be a list of the traversal tricks
 * somebody has thought of, and the useful property is the opposite one: a name is refused
 * unless it is obviously harmless. Lowercase letters, digits and dashes cannot express a
 * separator, a parent directory, a drive letter, a UNC path or a null byte.
 */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Names Windows refuses to create whatever the extension is.
 *
 * `con.json` cannot exist on Windows, and the failure is a permission error from the
 * filesystem rather than anything a reader would connect to a widget called `con`.
 */
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** 256 KB. A to-do list is a few hundred bytes; anything near this is a mistake or an attack. */
const MAX_BYTES = 256 * 1024;

/**
 * The file for a widget's state, or a reason it has none.
 *
 * @param {string} home  the resolved ~/.hikari
 * @param {unknown} id
 * @returns {{path: string} | {error: string}}
 */
function statePath(home, id) {
  if (typeof id !== "string" || id === "") return { error: "a widget with no id cannot store anything" };
  if (!SAFE_ID.test(id)) {
    // Named in the message, because the alternative is a widget that silently never
    // remembers anything and a folder name nobody thinks to look at.
    return { error: `"${id}" is not a usable widget id. Use lowercase letters, digits and dashes.` };
  }
  if (RESERVED.has(id)) return { error: `"${id}" is a reserved device name on Windows` };

  const dir = path.join(home, "state");
  const file = path.join(dir, `${id}.json`);

  // Belt and braces. The pattern above already makes this unreachable, and it is here
  // because the cost of being wrong is writing outside the state directory and the cost of
  // the check is a string comparison. A guard is worth having for what happens when it
  // fires, not for whether it can.
  const resolved = path.resolve(file);
  if (path.dirname(resolved) !== path.resolve(dir)) {
    return { error: `"${id}" resolves outside the state directory` };
  }

  return { path: resolved, dir: path.resolve(dir) };
}

/**
 * A stored value, or null.
 *
 * Total. A state file that has been hand-edited into invalid JSON must not stop the widget
 * loading: the widget starts empty, which is recoverable, rather than not starting, which
 * looks like the app is broken.
 */
function readState(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    const parsed = JSON.parse(text);
    return parsed === undefined ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * A value ready to write, or a reason it is refused.
 *
 * Serialised here rather than at the call site so the size is measured on the bytes that
 * would actually land on disk. Measuring the object would measure the wrong thing.
 *
 * @returns {{text: string} | {error: string}}
 */
function writable(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    // A cycle, or a BigInt. Refused with the reason rather than writing "undefined" into
    // the file, which is what an unguarded JSON.stringify would leave behind.
    return { error: `that value cannot be stored: ${e.message}` };
  }
  // `undefined` stringifies to undefined, not to a string, and writing that produces the
  // four characters "undefined" which then fail to parse on the way back in.
  if (text === undefined) return { error: "there is nothing to store" };

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BYTES) {
    return { error: `that is ${Math.round(bytes / 1024)} KB and the limit is ${MAX_BYTES / 1024} KB` };
  }
  return { text };
}

module.exports = { SAFE_ID, RESERVED, MAX_BYTES, statePath, readState, writable };
