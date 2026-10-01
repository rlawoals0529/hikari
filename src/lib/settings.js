/**
 * What a settings surface is allowed to change, and how each change is bounded.
 *
 * A widget that can write `~/.hikari/config.json` is more powerful than any other, because
 * that file decides which widgets run. So there is no "write this config" call. There are
 * four narrow ones, and each can only change one kind of thing:
 *
 *   enabled    a boolean, per widget
 *   anchor     one of nine, per widget
 *   offset     two integers, clamped, per widget
 *   palette    one of the palettes actually on disk
 *
 * **A capability can never be written by any of them**, which is the reason this is safe at
 * all. Capabilities are read from a `widget.json` and not from this file, so even a call
 * that wrote arbitrary keys could not grant itself the clipboard. These are narrow anyway,
 * because defence that rests on one layer is defence that rests on that layer never
 * changing.
 *
 * Everything here is pure: it produces the patch to merge, and the host does the writing.
 */

/**
 * Everything below is inside one block, and that is not a style choice.
 *
 * Widgets load these libraries as classic scripts, which share one global scope, so a
 * top-level `const` of a name another file already declared is a redeclaration
 * SyntaxError -- and the browser discards the whole file, not the line. That failure has
 * already happened here: the symptom was a widget going blank while complaining about a
 * global belonging to a file it never mentions. This file wants `isRecord` and `SAFE_ID`,
 * both of which a sibling already has, so rather than renaming them to be unique across a
 * scope this file does not otherwise care about, none of them are in that scope at all.
 *
 * `test/globals.test.js` is the guard that catches the alternative.
 */
{
  /** The nine `place()` understands. Anything else silently becomes top_right, which is worse. */
  const ANCHORS = [
    "top_left",
    "top_center",
    "top_right",
    "middle_left",
    "middle_center",
    "middle_right",
    "bottom_left",
    "bottom_center",
    "bottom_right",
  ];

  /**
   * How far a widget may be nudged from its anchor.
   *
   * Wide enough to reach anywhere on a large display, bounded so a typo or a held key cannot
   * put a widget somewhere no monitor is. A widget at an offset of ten thousand is gone, and
   * the only way back is editing the file the widget was supposed to save you from editing.
   */
  const MAX_OFFSET = 4000;

  /** The same shape every id in this app has to be. */
  const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

  const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  /**
   * A palette's name, whether it arrived as a name or as a palette.
   *
   * Both callers below take the same list, and it can be either shape: the host lists names
   * off the disk, then reads a colour or two out of each file so the picker can show what a
   * palette looks like rather than fifteen words. One reader for both keeps the checked list
   * and the drawn list from drifting apart, which is the way a picker ends up offering a
   * palette the check will then refuse.
   */
  function nameOf(p) {
    if (typeof p === "string") return p;
    return isRecord(p) && typeof p.name === "string" ? p.name : null;
  }

  /** An id, or the reason it is not one. */
  function readId(id) {
    if (typeof id !== "string" || !SAFE_ID.test(id)) {
      return { error: `"${String(id)}" is not a widget id` };
    }
    return { id };
  }

  /**
   * The patch that switches a widget on or off.
   *
   * `enabled` and nothing else. A call that took a whole object would let a settings widget
   * write any key under `widgets.<id>`, which is the shape this is deliberately not.
   */
  function enabledPatch(id, on, known) {
    const check = readId(id);
    if (check.error) return check;
    if (typeof on !== "boolean") return { error: `enabled has to be true or false, not ${JSON.stringify(on)}` };
    if (Array.isArray(known) && !known.includes(id)) {
      return { error: `there is no widget called "${id}"${known.length ? `. Known: ${known.join(", ")}` : ""}` };
    }
    return { patch: { widgets: { [id]: { enabled: on } } } };
  }

  /** The patch that moves a widget to one of the nine anchors. */
  function anchorPatch(id, anchor, known) {
    const check = readId(id);
    if (check.error) return check;
    if (!ANCHORS.includes(anchor)) {
      return { error: `"${String(anchor)}" is not an anchor. One of: ${ANCHORS.join(", ")}` };
    }
    if (Array.isArray(known) && !known.includes(id)) {
      return { error: `there is no widget called "${id}"` };
    }
    return { patch: { widgets: { [id]: { anchor } } } };
  }

  /**
   * The patch that nudges a widget, clamped.
   *
   * Absolute, not relative, and that is deliberate. A relative call has to read the current
   * value to add to it, which means two calls racing on a held arrow key can lose one of the
   * increments and drift. The widget knows where it is; it says where it wants to be.
   */
  function offsetPatch(id, x, y, known) {
    const check = readId(id);
    if (check.error) return check;
    if (Array.isArray(known) && !known.includes(id)) {
      return { error: `there is no widget called "${id}"` };
    }
    for (const [name, v] of [
      ["offsetX", x],
      ["offsetY", y],
    ]) {
      // Integers only. A fractional offset lands a window on a half pixel, which on some
      // displays blurs everything inside it and looks like a rendering bug.
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { error: `${name} has to be a number, not ${JSON.stringify(v)}` };
      }
    }
    const clamp = (v) => Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(v)));
    return { patch: { widgets: { [id]: { offsetX: clamp(x), offsetY: clamp(y) } } } };
  }

  /**
   * The palette to apply, checked against the ones that actually exist.
   *
   * `available` is a directory listing, so this is an allowlist of real files rather than a
   * pattern a name has to satisfy. That is the difference between refusing `../../etc/passwd`
   * because it does not match a regex and refusing it because it is not one of the five
   * palettes on the disk, and the second cannot be outsmarted.
   */
  function paletteChoice(name, available) {
    if (typeof name !== "string" || name.trim() === "") return { error: "no palette named" };
    const wanted = name.trim();
    const list = (Array.isArray(available) ? available : []).map(nameOf).filter((n) => n !== null);
    if (!list.includes(wanted)) {
      return { error: `"${wanted}" is not a palette here${list.length ? `. One of: ${list.join(", ")}` : ""}` };
    }
    return { palette: wanted };
  }

  /**
   * What the settings surface needs to draw itself.
   *
   * Built from what the host already knows rather than from a second read of the config, so
   * the list cannot disagree with what is on screen.
   */
  function describe(widgets, running, palettes, current) {
    const live = new Set(running);
    return {
      anchors: [...ANCHORS],
      // Always the object shape, so the surface has one thing to draw. A palette whose file
      // gave up no colours still lists, with nulls: a name is enough to pick by, and hiding it
      // would mean a palette that exists and cannot be chosen.
      palettes: (Array.isArray(palettes) ? palettes : [])
        .map((p) => ({ name: nameOf(p), accent: isRecord(p) ? (p.accent ?? null) : null, bg: isRecord(p) ? (p.bg ?? null) : null }))
        .filter((p) => p.name !== null),
      palette: typeof current === "string" ? current : null,
      maxOffset: MAX_OFFSET,
      widgets: (Array.isArray(widgets) ? widgets : [])
        .filter((w) => isRecord(w) && typeof w.id === "string")
        .map((w) => ({
          id: w.id,
          // A widget that is configured off is still listed, or there would be no way to turn
          // it back on from here, which is the one thing a settings surface has to be able to
          // do.
          enabled: w.enabled !== false,
          running: live.has(w.id),
          anchor: ANCHORS.includes(w.anchor) ? w.anchor : "top_right",
          offsetX: Number.isFinite(w.offsetX) ? w.offsetX : 0,
          offsetY: Number.isFinite(w.offsetY) ? w.offsetY : 0,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

    const api = { ANCHORS, MAX_OFFSET, nameOf, enabledPatch, anchorPatch, offsetPatch, paletteChoice, describe };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") window.hikariSettings = api;
}
