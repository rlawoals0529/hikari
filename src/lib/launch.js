/**
 * What the dock is allowed to start, and everything it is not.
 *
 * This is the one part of hikari where a mistake is a security bug rather than a wrong
 * number. A widget that can start programs is arbitrary code execution wearing a toolbar,
 * unless the authority is bounded, so the shape matters more than the feature.
 *
 * **The renderer can never name what to run.** It calls `launch(id)`, and `id` indexes the
 * user's own config. There is no parameter for a path, a URI, an argument or a command
 * string, so there is nothing to inject into and nothing to traverse out of. A widget can
 * ask for entry `"steam"` and it cannot ask for anything the user did not write down.
 *
 * **Nothing is ever handed to a shell.** `shell.openPath` for a filesystem entry and
 * `shell.openExternal` for a URI, both of which take a value rather than a command line.
 * There is no `child_process` in this file or in the code that calls it, so quoting,
 * metacharacters and argument splitting stop being a category of bug rather than being
 * handled carefully.
 *
 * Everything here is pure. The refusals are the design, so they are the tests.
 */

/**
 * Schemes `openExternal` may be given. An allowlist, and a short one.
 *
 * `shell.openExternal` on an arbitrary scheme is a known foot-gun: the OS resolves it
 * through whatever handler is registered, and the set of registered handlers on a real
 * machine is long and surprising. A denylist would be a list of the ones somebody thought
 * of.
 *
 * `file:` is absent deliberately and is refused by name below. A filesystem target goes
 * through `openPath`, which is the call that expects one; letting `file:` in through the URI
 * path would mean two ways to reach the disk and only one of them checked.
 */
const ALLOWED_SCHEMES = new Set(["steam:", "http:", "https:", "mailto:"]);

/** Refused by name, so the message can say which call to use instead. */
const REDIRECTED_SCHEMES = new Map([
  ["file:", 'use "path" rather than a file: URI, so it goes through the call that checks it'],
  ["javascript:", "that is not a thing to launch"],
  ["data:", "that is not a thing to launch"],
  ["vbscript:", "that is not a thing to launch"],
]);

/** As long as a real label needs, short enough that one cannot fill the dock. */
const MAX_LABEL = 40;

/** More than fits on a dock, and a stop on a config that grew by accident. */
const MAX_ENTRIES = 30;

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * One entry, or the reason it is refused.
 *
 * An entry must have exactly one of `path` and `uri`. Both is refused rather than resolved,
 * because there is no correct answer to which one was meant and picking one silently is how
 * a dock button starts the wrong thing.
 */
function readEntry(raw, index) {
  const at = `entry ${index + 1}`;
  if (!isRecord(raw)) return { error: `${at} is not an object` };

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  // The id is what the renderer sends, so it has to be something a message can carry and
  // nothing more. No separators, no dots: an id is a name, not a path.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    return { error: `${at} needs an "id" of lowercase letters, digits and dashes` };
  }

  const label = typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label.trim().slice(0, MAX_LABEL) : id;

  const hasPath = typeof raw.path === "string" && raw.path.trim() !== "";
  const hasUri = typeof raw.uri === "string" && raw.uri.trim() !== "";

  if (hasPath && hasUri) {
    return { error: `${at} ("${id}") has both "path" and "uri". Keep one, because there is no right way to guess.` };
  }
  if (!hasPath && !hasUri) return { error: `${at} ("${id}") has neither "path" nor "uri"` };

  if (hasPath) {
    const value = raw.path.trim();
    // Absolute only. A relative path resolves against the app's working directory, which is
    // wherever it happened to be started from, so the same config would launch different
    // things on different days.
    const absolute = /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
    if (!absolute) return { error: `${at} ("${id}") path "${value}" is not absolute` };
    return { entry: { id, label, kind: "path", value } };
  }

  const written = raw.uri.trim();
  let parsed;
  try {
    // Parsed rather than pattern-matched, because a scheme is what a URL parser says it is.
    // "https:/x" and "HtTpS://x" both need the same answer as "https://x".
    parsed = new URL(written);
  } catch {
    return { error: `${at} ("${id}") uri "${written}" is not a URI` };
  }

  const scheme = parsed.protocol.toLowerCase();
  const redirect = REDIRECTED_SCHEMES.get(scheme);
  if (redirect) return { error: `${at} ("${id}") ${scheme} is refused: ${redirect}` };
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return {
      error: `${at} ("${id}") ${scheme} is not an allowed scheme. Allowed: ${[...ALLOWED_SCHEMES].join(" ")}`,
    };
  }

  // A scheme with nothing after it is not a target. `new URL("steam:")` parses happily and
  // has an allowed protocol, so the scheme check alone let it through; asking the OS to
  // open an empty steam URI does nothing useful and the config that contains it is a typo
  // worth reporting.
  if (written.length <= scheme.length) {
    return { error: `${at} ("${id}") uri "${written}" is a scheme with nothing after it` };
  }

  /**
   * The parser's own canonical form, not the text as written.
   *
   * This closes the gap between what was checked and what gets launched: `https:/x` was
   * validated as https and would have been handed to the OS as `https:/x`, leaving the OS
   * to do its own interpretation of a string this code had already decided about. `href` is
   * what the parser agrees the URI means. Verified not to disturb a steam URI:
   * `steam://rungameid/440` comes back unchanged, while `HTTPS://Example.COM/A` is
   * lowercased to its real host.
   */
  return { entry: { id, label, kind: "uri", value: parsed.href } };
}

/**
 * The dock's entries, and every reason one was left out.
 *
 * Both halves are returned. A refused entry that vanishes silently is a dock with a missing
 * button and no way to find out why, which is the failure mode of every config format that
 * skips what it cannot read.
 *
 * @returns {{entries: object[], problems: string[]}}
 */
function readEntries(config) {
  const raw = Array.isArray(config?.entries) ? config.entries : Array.isArray(config) ? config : [];
  const entries = [];
  const problems = [];
  const seen = new Set();

  for (const [i, item] of raw.entries()) {
    if (entries.length >= MAX_ENTRIES) {
      problems.push(`more than ${MAX_ENTRIES} entries, so the rest are ignored`);
      break;
    }
    const result = readEntry(item, i);
    if (result.error) {
      problems.push(result.error);
      continue;
    }
    // A duplicate id means one of two buttons can never be reached, because a lookup by id
    // finds the first. Refused rather than silently shadowed.
    if (seen.has(result.entry.id)) {
      problems.push(`entry ${i + 1} repeats the id "${result.entry.id}", so it is ignored`);
      continue;
    }
    seen.add(result.entry.id);
    entries.push(result.entry);
  }

  return { entries, problems };
}

/**
 * What an id resolves to, or the reason it resolves to nothing.
 *
 * A strict comparison against an array, never a property lookup on an object. A map keyed by
 * id would answer `"__proto__"` and `"constructor"` with something inherited, and the value
 * would then be handed to a shell call. Nothing here indexes by the value a renderer sent.
 *
 * @returns {{kind: string, value: string, label: string} | {error: string}}
 */
function resolveTarget(entries, id) {
  if (typeof id !== "string" || id === "") return { error: "launch needs an entry id" };
  const found = entries.find((e) => e.id === id);
  // Refused loudly, never treated as a no-op. A dock button that silently does nothing is
  // indistinguishable from a broken app, and the config that is missing an entry is the
  // thing nobody thinks to look at.
  if (!found) {
    const known = entries.map((e) => e.id);
    return {
      error: `no dock entry called "${id}"${known.length ? `. Known: ${known.join(", ")}` : " and the dock is empty"}`,
    };
  }
  return { kind: found.kind, value: found.value, label: found.label };
}

/**
 * A Steam game as a dock entry.
 *
 * `steam://rungameid/<appid>` is how Steam is asked to start one specific game, and the
 * appid comes out of `appmanifest_*.acf`, which is already parsed elsewhere in this account
 * for the shelf visualiser. So installed games can appear in the dock with no new parser, no
 * scrape and no key.
 */
function steamEntry(appid, name) {
  const id = String(appid).trim();
  if (!/^[0-9]+$/.test(id)) return null;
  return {
    id: `steam-${id}`,
    label: typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, MAX_LABEL) : `Steam ${id}`,
    kind: "uri",
    value: `steam://rungameid/${id}`,
  };
}

module.exports = {
  ALLOWED_SCHEMES,
  REDIRECTED_SCHEMES,
  MAX_ENTRIES,
  MAX_LABEL,
  readEntry,
  readEntries,
  resolveTarget,
  steamEntry,
};
