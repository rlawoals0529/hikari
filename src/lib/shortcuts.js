/**
 * Shortcuts you define yourself, on top of the one a widget asks for.
 *
 * A `hotkey` in a `widget.json` is the widget author's choice, and one per widget. This is
 * the user's own map, in `~/.hikari/config.json`:
 *
 *   "shortcuts": {
 *     "Alt+Space":       "toggle:decoder",
 *     "CommandOrControl+Alt+S": "launch:steam",
 *     "Alt+R":           "refresh"
 *   }
 *
 * **An action is a verb and a name, never a command.** There is no shell string, no path and
 * no argument list, so a shortcut cannot run something the user did not already configure
 * somewhere else: `launch:steam` reaches the dock entry called steam and nothing else. The
 * same bound authority as the dock, for the same reason.
 *
 * Conflict detection is shared with the widget hotkeys rather than done twice. Two things
 * asking for one accelerator is the failure that matters most here, because the loser is
 * silent: the key works, and does the other thing.
 */
const { parseAccelerator, canonical } = require("./hotkeys");

/**
 * Every verb, and whether it names a target.
 *
 * A closed set. An unknown verb is refused rather than ignored, because a typo in a
 * shortcut is otherwise a key that does nothing and a config that looks correct.
 */
const ACTIONS = {
  toggle: { needsTarget: true, what: "a widget id" },
  reload: { needsTarget: true, what: "a widget id" },
  launch: { needsTarget: true, what: "a dock entry id" },
  refresh: { needsTarget: false, what: null },
  hideAll: { needsTarget: false, what: null },
};

/** The same shape a widget id or a dock entry id has to be. */
const SAFE_TARGET = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * One action, or the reason it is refused.
 *
 * @returns {{verb: string, target: string | null} | {error: string}}
 */
function readAction(text) {
  if (typeof text !== "string" || text.trim() === "") return { error: "an empty action does nothing" };
  const trimmed = text.trim();

  // Split on the first colon only. A target cannot contain one, so anything after a second
  // colon is a mistake worth naming rather than silently keeping.
  const colon = trimmed.indexOf(":");
  const verb = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const target = colon === -1 ? null : trimmed.slice(colon + 1).trim();

  const spec = Object.prototype.hasOwnProperty.call(ACTIONS, verb) ? ACTIONS[verb] : null;
  if (!spec) {
    return { error: `"${verb}" is not an action. One of: ${Object.keys(ACTIONS).join(", ")}` };
  }

  if (spec.needsTarget) {
    if (target === null || target === "") return { error: `"${verb}" needs ${spec.what}, as in "${verb}:something"` };
    if (!SAFE_TARGET.test(target)) {
      return { error: `"${target}" is not ${spec.what}. Use lowercase letters, digits and dashes.` };
    }
    return { verb, target };
  }

  // A target on a verb that takes none is a misunderstanding, not something to drop
  // quietly: somebody wrote "refresh:weather" expecting one provider to refresh.
  if (target !== null && target !== "") {
    return { error: `"${verb}" takes no target, so "${trimmed}" is asking for something it cannot do` };
  }
  return { verb, target: null };
}

/**
 * The user's shortcut map, resolved against what actually exists.
 *
 * `widgetIds` and `dockIds` are passed in so a shortcut naming something that is not there
 * is refused at startup with the reason, rather than binding a key that fails silently when
 * pressed. That distinction is the whole point: a key that does nothing is indistinguishable
 * from a broken app.
 *
 * @returns {{bindings: object[], problems: string[]}}
 */
function readShortcuts(config, widgetIds = [], dockIds = []) {
  const raw = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const bindings = [];
  const problems = [];
  const taken = new Map();

  for (const [accelerator, action] of Object.entries(raw)) {
    const parsed = parseAccelerator(accelerator);
    if (!parsed.ok) {
      problems.push(`shortcut "${accelerator}" is not usable: ${parsed.reason}`);
      continue;
    }

    const resolved = readAction(action);
    if (resolved.error) {
      problems.push(`shortcut "${accelerator}": ${resolved.error}`);
      continue;
    }

    if (resolved.verb === "toggle" || resolved.verb === "reload") {
      if (!widgetIds.includes(resolved.target)) {
        problems.push(
          `shortcut "${accelerator}" names widget "${resolved.target}", which does not exist` +
            (widgetIds.length ? `. Known: ${widgetIds.join(", ")}` : " and no widgets are loaded"),
        );
        continue;
      }
    }
    if (resolved.verb === "launch") {
      if (!dockIds.includes(resolved.target)) {
        problems.push(
          `shortcut "${accelerator}" launches "${resolved.target}", which is not a dock entry` +
            (dockIds.length ? `. Known: ${dockIds.join(", ")}` : " and the dock is empty"),
        );
        continue;
      }
    }

    const key = canonical(parsed);
    const owner = taken.get(key);
    if (owner) {
      // Two spellings of one accelerator in the same map. Registering both would leave one
      // silently unreachable.
      problems.push(`shortcut "${accelerator}" is the same key as "${owner}"`);
      continue;
    }
    taken.set(key, accelerator);
    bindings.push({ accelerator: accelerator.trim(), canonical: key, ...resolved });
  }

  return { bindings, problems };
}

/**
 * Widget hotkeys and user shortcuts, merged, with every collision reported.
 *
 * The user's map wins, because they wrote it more recently and more deliberately than a
 * widget author chose a default. The widget's hotkey is then reported as overridden rather
 * than dropped in silence, which is the difference between a considered override and a key
 * that mysteriously stopped working.
 */
function merge(widgetBindings, shortcutBindings) {
  const problems = [];
  const byKey = new Map();

  for (const b of shortcutBindings) byKey.set(b.canonical, { ...b, from: "config" });

  for (const b of widgetBindings) {
    const clash = byKey.get(b.canonical);
    if (clash) {
      problems.push(
        `widget "${b.id}" wants ${b.accelerator}, but your shortcuts use that key for ` +
          `"${clash.verb}${clash.target ? `:${clash.target}` : ""}". Yours wins.`,
      );
      continue;
    }
    byKey.set(b.canonical, { ...b, from: "widget", verb: "toggle", target: b.id });
  }

  return { bindings: [...byKey.values()], problems };
}

module.exports = { ACTIONS, readAction, readShortcuts, merge };
