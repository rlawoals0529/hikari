/**
 * Which global shortcut each widget asked for, and what is wrong with the rest.
 *
 * A global shortcut that silently does nothing is the whole failure mode of this feature.
 * `globalShortcut.register` returns false when the accelerator is already taken by another
 * application, and a typo in the accelerator is worse still: nothing is registered, nothing
 * is said, and the key you press belongs to some other program. So every reason a binding
 * did not happen is collected here and reported, rather than being an absence.
 *
 * The grammar is Electron's: modifiers and one key code joined by `+`, case insensitive.
 * The lists below are transcribed from its Accelerator documentation for the version this
 * repo pins, which is why they are exhaustive rather than a guess at the common ones -- a
 * list that is too short refuses a shortcut that would have worked, and that is a worse
 * failure than accepting one Electron will reject, because the user cannot tell it from a
 * bug in the key itself.
 */

const MODIFIERS = new Set(
  ["Command", "Cmd", "Control", "Ctrl", "CommandOrControl", "CmdOrCtrl", "Alt", "Option", "AltGr", "Shift", "Super", "Meta"].map(
    (m) => m.toLowerCase(),
  ),
);

/** Modifiers that are the same key under a different name, so asking for both is a typo. */
const SAME_MODIFIER = new Map(
  Object.entries({
    cmd: "command",
    ctrl: "control",
    cmdorctrl: "commandorcontrol",
    option: "alt",
    meta: "super",
  }),
);

const PUNCTUATION = new Set([
  ")", "!", "@", "#", "$", "%", "^", "&", "*", "(", ":", ";", "+", "=", "<", ",", "_", "-",
  ">", ".", "?", "/", "~", "`", "{", "]", "[", "|", "\\", "}", '"',
]);

const NAMED = new Set(
  [
    "Plus", "Space", "Tab", "Capslock", "Numlock", "Scrolllock", "Backspace", "Delete",
    "Insert", "Return", "Enter", "Up", "Down", "Left", "Right", "Home", "End", "PageUp",
    "PageDown", "Escape", "Esc", "VolumeUp", "VolumeDown", "VolumeMute", "MediaNextTrack",
    "MediaPreviousTrack", "MediaStop", "MediaPlayPause", "PrintScreen",
    "numdec", "numadd", "numsub", "nummult", "numdiv",
  ].map((k) => k.toLowerCase()),
);

const isKeyCode = (t) =>
  PUNCTUATION.has(t) ||
  NAMED.has(t) ||
  /^[0-9a-z]$/.test(t) ||
  /^f([1-9]|1[0-9]|2[0-4])$/.test(t) ||
  /^num[0-9]$/.test(t);

/**
 * @param {unknown} text
 * @returns {{ok: true, modifiers: string[], key: string} | {ok: false, reason: string}}
 */
function parseAccelerator(text) {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "it is not a string" };
  const parts = text.trim().split("+");
  // "Ctrl++" splits into an empty segment, because `+` is both the separator and a key.
  // Electron's own answer to that is the name `Plus`, so say so instead of guessing.
  if (parts.some((p) => p === "")) {
    return { ok: false, reason: 'a literal "+" has to be written as "Plus", because "+" separates the parts' };
  }

  const tokens = parts.map((p) => p.trim().toLowerCase());
  const key = tokens[tokens.length - 1];
  const modifiers = tokens.slice(0, -1);

  for (const m of modifiers) {
    if (!MODIFIERS.has(m)) {
      // Naming the token matters: "Ctrl+Shft+K" is a one-character typo and the message
      // has to point at "shft" rather than at the whole accelerator.
      return { ok: false, reason: `"${m}" is not a modifier, and only the last part may be a key` };
    }
  }
  if (!isKeyCode(key)) return { ok: false, reason: `"${key}" is not a key Electron knows` };

  // A global shortcut with no modifier takes that key away from every application on the
  // machine, including the one in front of you. Refusing it is not pedantry.
  if (modifiers.length === 0) return { ok: false, reason: "a global shortcut needs at least one modifier" };

  const canonical = modifiers.map((m) => SAME_MODIFIER.get(m) ?? m);
  const seen = new Set();
  for (const m of canonical) {
    if (seen.has(m)) return { ok: false, reason: `"${m}" is named twice` };
    seen.add(m);
  }

  return { ok: true, modifiers, key };
}

/**
 * The same shortcut written two ways, reduced to one string.
 *
 * `Ctrl+Shift+K` and `shift+control+k` are one shortcut, and without this the second widget
 * to ask for it would be handed a registration that silently loses to the first.
 */
function canonical(parsed) {
  const mods = parsed.modifiers.map((m) => SAME_MODIFIER.get(m) ?? m).sort();
  return [...mods, parsed.key].join("+");
}

/**
 * Split the widgets into shortcuts to register and problems to report.
 *
 * @param {{id: string, manifest: object}[]} widgets
 * @returns {{bindings: {id: string, accelerator: string, canonical: string}[],
 *            problems: {id: string, accelerator: unknown, reason: string}[]}}
 */
function plan(widgets) {
  const bindings = [];
  const problems = [];
  const taken = new Map();

  for (const { id, manifest } of widgets) {
    const accelerator = manifest?.hotkey;
    if (accelerator === undefined || accelerator === null) continue;

    const parsed = parseAccelerator(accelerator);
    if (!parsed.ok) {
      problems.push({ id, accelerator, reason: parsed.reason });
      continue;
    }

    const key = canonical(parsed);
    const owner = taken.get(key);
    if (owner) {
      // First asked wins, and the loser is told who has it. Registering both would mean one
      // of them never fires, with nothing to say which.
      problems.push({ id, accelerator, reason: `"${owner}" already asked for that shortcut` });
      continue;
    }
    taken.set(key, id);
    bindings.push({ id, accelerator: String(accelerator).trim(), canonical: key });
  }

  return { bindings, problems };
}

module.exports = { parseAccelerator, canonical, plan };
