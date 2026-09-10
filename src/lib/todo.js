/**
 * A list of things to do, as a value.
 *
 * Every operation takes a list and returns a new one, which is what lets the widget be a
 * thin thing that renders and the host be a thin thing that writes. Nothing here touches a
 * file or a clock: the id and the timestamp are passed in, so the same input always gives
 * the same output and a test can assert an id rather than a shape.
 *
 * The list is stored, so **every function has to survive reading a file somebody has edited
 * by hand.** That is not a hypothetical for this widget: `~/.hikari/state/todo.json` is
 * plain JSON in a directory people are told to open, and someone will fix a typo in it.
 * So `normalise` runs on the way in and drops what it cannot understand rather than
 * throwing, and the widget starts with whatever survived.
 */

/** Long enough for a real task, short enough that one entry cannot fill the widget. */
const MAX_TEXT = 200;

/** More than fits on any reasonable desktop widget, and a stop on a runaway loop. */
const MAX_ITEMS = 200;

// Named for this file rather than the obvious `isPlain`, because config.js already declares
// that at the top level and the widget loads both as classic scripts into one global scope.
// The collision was caught by test/globals.test.js, which is what it is for.
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * One item, or null.
 *
 * `done` is coerced to a real boolean because a hand-edited `"done": "true"` is a string,
 * and a truthy check would make `"false"` mean done. That is the same mistake the capability
 * check refuses to make, for the same reason: a value that flips when you try to write it
 * off is the worst direction for the error.
 */
function readItem(raw) {
  if (!isRecord(raw)) return null;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  // An item with no text is not an item. It would render as a blank row with a checkbox and
  // no way to tell what it was for.
  if (text === "") return null;
  return {
    id: typeof raw.id === "string" && raw.id !== "" ? raw.id : null,
    text: text.slice(0, MAX_TEXT),
    done: raw.done === true,
    at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : null,
  };
}

/**
 * A stored value as a list, dropping whatever cannot be read.
 *
 * Items with no id get one from their position, so a hand-written file that just lists text
 * works. That is a deliberate kindness: somebody adding three lines to the file by hand
 * should get three tasks, not an empty widget.
 */
function normalise(stored) {
  const raw = Array.isArray(stored) ? stored : Array.isArray(stored?.items) ? stored.items : [];
  const seen = new Set();
  const out = [];
  for (const [i, entry] of raw.entries()) {
    const item = readItem(entry);
    if (!item) continue;
    // A duplicate id would make toggling one row toggle two, which looks like a rendering
    // bug and is a data one.
    let id = item.id ?? `hand-${i}`;
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    out.push({ ...item, id });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * Add an item.
 *
 * @param {object[]} list
 * @param {string} text
 * @param {string} id   supplied, so this stays pure and a test can name it
 * @param {number} at
 */
function add(list, text, id, at) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "") return list;
  if (list.length >= MAX_ITEMS) return list;
  // Newest first. A list you add to at the bottom needs scrolling to see what you just
  // typed, which on a widget this size means it appears to have done nothing.
  return [{ id, text: trimmed.slice(0, MAX_TEXT), done: false, at }, ...list];
}

/** Flip one item. An id that is not in the list is a no-op rather than a throw. */
function toggle(list, id) {
  return list.map((item) => (item.id === id ? { ...item, done: !item.done } : item));
}

/** Remove one item. */
function remove(list, id) {
  return list.filter((item) => item.id !== id);
}

/** Remove everything already done, which is the only bulk action worth having. */
function clearDone(list) {
  return list.filter((item) => !item.done);
}

/**
 * What to show, and what it adds up to.
 *
 * Done items sink rather than disappear, because a list that hides what you finished gives
 * you nothing for finishing it. They keep their order among themselves so the list does not
 * reshuffle while you tick things off.
 */
function view(list) {
  const open = list.filter((i) => !i.done);
  const done = list.filter((i) => i.done);
  return { items: [...open, ...done], open: open.length, done: done.length, total: list.length };
}

// Block-scoped so `api` is not a global. The widget loads this beside config.js as a
// classic script, and they share one global scope: a second top-level `const api` is a
// redeclaration SyntaxError that discards the whole file, and the symptom is an undefined
// `window.hikariTodo` in a widget that never mentions `api`.
{
  const api = { MAX_TEXT, MAX_ITEMS, readItem, normalise, add, toggle, remove, clearDone, view };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.hikariTodo = api;
}
