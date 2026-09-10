const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ANCHORS,
  MAX_OFFSET,
  enabledPatch,
  anchorPatch,
  offsetPatch,
  paletteChoice,
  describe: describeSettings,
} = require("../src/lib/settings");
const { merge } = require("../src/lib/config");
const Module = require("node:module");

// place() is in the host, which imports electron at module load. Same stub as place.test.js,
// because the nine anchors are only worth listing here if they are the nine that file resolves.
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") {
    return {
      app: { getPath: () => "/nonexistent-home", whenReady: () => ({ then() {} }), on() {} },
      BrowserWindow: class {},
      ipcMain: { handle() {}, on() {} },
      globalShortcut: { unregisterAll() {}, register: () => true },
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
      shell: {},
      clipboard: {},
      nativeImage: {},
    };
  }
  return origLoad.apply(this, arguments);
};
const { place } = require("../src/main.js");
Module._load = origLoad;

const KNOWN = ["clock", "shader", "todo"];

test("each of the nine anchors puts a widget somewhere different", () => {
  // The list is pinned against place() rather than restated, because the failure when the
  // two disagree is silent: place() falls back per half, so a name it does not know lands
  // the widget at top_right and says nothing.
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const seen = new Map();
  for (const anchor of ANCHORS) {
    const at = place(display, { anchor, width: 200, height: 100, margin: 16 });
    seen.set(`${at.x},${at.y}`, anchor);
  }
  assert.equal(ANCHORS.length, 9);
  assert.equal(seen.size, 9, `two anchors resolve to one position: ${[...seen.values()].join(", ")}`);
});

test("an anchor place() does not know is accepted silently, which is why the list is closed", () => {
  // place() splits on "_" and falls back per half, so a misspelling is not refused and is
  // not even a near miss. "top-left" has no underscore, so neither half matches and the
  // widget goes to the *diagonal opposite* of what was asked for. Nothing is logged.
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const asked = place(display, { anchor: "top_left", width: 200, height: 100, margin: 16 });
  const got = place(display, { anchor: "top-left", width: 200, height: 100, margin: 16 });
  assert.deepEqual(asked, { x: 16, y: 16, width: 200, height: 100 });
  assert.deepEqual(got, { x: 1704, y: 964, width: 200, height: 100 }, "bottom right, not top left");

  // So the closed list is the only thing standing between a typo and that. Every spelling
  // somebody will actually try has to be refused here.
  for (const wrong of ["top-left", "middle", "centre", "nowhere", "top_middle", "left_top"]) {
    assert.ok(anchorPatch("clock", wrong, KNOWN).error, wrong);
    const at = place(display, { anchor: wrong, width: 200, height: 100 });
    assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y), `${wrong} is placed, not refused`);
  }
});

// --- enabled ------------------------------------------------------------------------------

test("turning a widget off is a patch and nothing more", () => {
  assert.deepEqual(enabledPatch("clock", false, KNOWN), {
    patch: { widgets: { clock: { enabled: false } } },
  });
});

test("enabled has to be a boolean, so a truthy string cannot switch a widget on", () => {
  // "false" is truthy, which is how a settings UI that forwards a form value turns a widget
  // on when the user asked for off.
  for (const v of ["true", "false", 1, 0, null, undefined, {}]) {
    assert.match(enabledPatch("clock", v, KNOWN).error, /true or false/, JSON.stringify(v));
  }
});

test("a widget that is not loaded is refused, and the real ones are named", () => {
  const e = enabledPatch("clok", true, KNOWN).error;
  assert.match(e, /no widget called "clok"/);
  assert.match(e, /Known: clock, shader, todo/);
});

test("with no list to check against, the id shape is still enforced", () => {
  // `known` is optional so the host can call this before discovery has run.
  assert.ok(!enabledPatch("clock", true, undefined).error);
  assert.ok(enabledPatch("../../etc/passwd", true, undefined).error);
});

// --- the ids, which become object keys ----------------------------------------------------

test("an id that is not a plain name is refused before it becomes a key", () => {
  for (const id of ["../x", "a/b", "A", "a b", "-a", "", "__proto__", "a.b", "a:b", " clock"]) {
    assert.ok(enabledPatch(id, true, undefined).error, JSON.stringify(id));
    assert.ok(anchorPatch(id, "top_left", undefined).error, JSON.stringify(id));
    assert.ok(offsetPatch(id, 0, 0, undefined).error, JSON.stringify(id));
  }
});

test("nothing at all is refused rather than throwing", () => {
  for (const id of [null, undefined, 42, {}, [], true]) {
    assert.ok(enabledPatch(id, true, KNOWN).error, JSON.stringify(id));
  }
});

test("a widget really called constructor is allowed, and lands as its own key", () => {
  // Not a blocklist, because the hazard was never the name: it was `userConfig.widgets[id]`
  // reaching the prototype, which is fixed at the lookup in config.js. A computed key in an
  // object literal is an own property, so the patch is a normal one.
  const { patch } = enabledPatch("constructor", false, ["constructor"]);
  assert.ok(Object.prototype.hasOwnProperty.call(patch.widgets, "constructor"));
  assert.equal(merge({ widgets: {} }, patch).widgets.constructor.enabled, false);
});

// --- anchor -------------------------------------------------------------------------------

test("each of the nine anchors is accepted", () => {
  for (const a of ANCHORS) assert.deepEqual(anchorPatch("clock", a, KNOWN).patch.widgets.clock, { anchor: a });
});

test("an anchor that is not one of the nine is refused and they are listed", () => {
  const e = anchorPatch("clock", "middle", KNOWN).error;
  assert.match(e, /"middle" is not an anchor/);
  assert.match(e, /top_left/);
});

test("a near miss is refused rather than corrected", () => {
  // top-left with a hyphen is the spelling somebody will try, and guessing at it would mean
  // the settings surface and the config file disagree about what an anchor is called.
  for (const a of ["top-left", "TOP_LEFT", " top_left", "center", null, 0]) {
    assert.ok(anchorPatch("clock", a, KNOWN).error, JSON.stringify(a));
  }
});

// --- offset -------------------------------------------------------------------------------

test("an offset is two integers", () => {
  assert.deepEqual(offsetPatch("clock", 12, -34, KNOWN).patch.widgets.clock, { offsetX: 12, offsetY: -34 });
});

test("a fractional offset is rounded, not refused", () => {
  // Half a pixel blurs a whole window on some displays, and a slider that emits 12.5 is a
  // reasonable thing for a settings UI to do, so this is the one place a value is fixed up.
  assert.deepEqual(offsetPatch("clock", 12.5, -0.4, KNOWN).patch.widgets.clock, { offsetX: 13, offsetY: -0 });
});

test("an offset past the clamp lands on the clamp", () => {
  const at = offsetPatch("clock", 999999, -999999, KNOWN).patch.widgets.clock;
  assert.deepEqual(at, { offsetX: MAX_OFFSET, offsetY: -MAX_OFFSET });
});

test("a held key cannot walk a widget off every monitor", () => {
  // The reason the clamp exists: the recovery from a widget at an offset of ten thousand is
  // editing the file the settings surface was supposed to replace.
  let x = 0;
  for (let i = 0; i < 5000; i++) x = offsetPatch("clock", x + 20, 0, KNOWN).patch.widgets.clock.offsetX;
  assert.equal(x, MAX_OFFSET);
});

test("a non-number offset is refused, and the name of the bad one is said", () => {
  assert.match(offsetPatch("clock", "12", 0, KNOWN).error, /offsetX has to be a number/);
  assert.match(offsetPatch("clock", 0, "0", KNOWN).error, /offsetY has to be a number/);
});

test("NaN and Infinity are refused rather than clamped", () => {
  // Math.min would turn Infinity into the clamp and NaN into NaN, and a NaN in a window
  // position is an invisible widget.
  for (const v of [NaN, Infinity, -Infinity]) {
    assert.ok(offsetPatch("clock", v, 0, KNOWN).error, String(v));
    assert.ok(offsetPatch("clock", 0, v, KNOWN).error, String(v));
  }
});

test("an offset is absolute, so two of them in a row do not accumulate", () => {
  // Deliberate: a relative call has to read the current value first, and two calls racing on
  // a held arrow key lose an increment.
  const a = offsetPatch("clock", 40, 0, KNOWN).patch;
  const b = offsetPatch("clock", 40, 0, KNOWN).patch;
  assert.equal(merge(a, b).widgets.clock.offsetX, 40);
});

// --- palette ------------------------------------------------------------------------------

test("a palette that is on disk is accepted", () => {
  assert.deepEqual(paletteChoice("ember", ["ember", "frost"]), { palette: "ember" });
});

test("a palette that is not on disk is refused, and the real ones are listed", () => {
  const e = paletteChoice("sunset", ["ember", "frost"]).error;
  assert.match(e, /"sunset" is not a palette here/);
  assert.match(e, /One of: ember, frost/);
});

test("a traversal is refused because it is not in the listing, not because of its shape", () => {
  // The difference that matters: this is an allowlist of files that exist, so there is no
  // pattern to outsmart.
  for (const p of ["../../etc/passwd", "../theme", "/etc/passwd", "ember/../frost", "__proto__"]) {
    assert.ok(paletteChoice(p, ["ember", "frost"]).error, p);
  }
});

test("with no palettes found, the message says so rather than listing nothing", () => {
  const e = paletteChoice("ember", []).error;
  assert.match(e, /is not a palette here/);
  assert.ok(!/One of:/.test(e), "an empty list must not be offered as the choices");
});

test("a palette name that is not a string is refused rather than throwing", () => {
  for (const p of [null, undefined, 42, {}, [], "", "   "]) {
    assert.ok(paletteChoice(p, ["ember"]).error, JSON.stringify(p));
  }
});

// --- describe -----------------------------------------------------------------------------

test("what the surface draws comes from what the host already knows", () => {
  const shown = describeSettings(
    [
      { id: "todo", enabled: true, anchor: "bottom_left", offsetX: 20, offsetY: 0 },
      { id: "clock", enabled: false, anchor: "top_right" },
    ],
    ["todo"],
    ["ember", "frost"],
    "ember",
  );
  assert.deepEqual(shown.widgets.map((w) => w.id), ["clock", "todo"], "sorted, so the list does not reorder itself");
  assert.equal(shown.palette, "ember");
  assert.equal(shown.maxOffset, MAX_OFFSET);
});

test("a widget that is switched off is still listed", () => {
  // Otherwise there is no way to turn it back on from here, which is the one thing this
  // surface has to be able to do.
  const shown = describeSettings([{ id: "clock", enabled: false }], [], [], null);
  assert.equal(shown.widgets.length, 1);
  assert.equal(shown.widgets[0].enabled, false);
  assert.equal(shown.widgets[0].running, false);
});

test("configured and running are separate, because a widget can be either without the other", () => {
  // Enabled and not running means it crashed or has not been created yet, and that is worth
  // seeing rather than smoothing over.
  const shown = describeSettings([{ id: "clock", enabled: true }], [], [], null);
  assert.equal(shown.widgets[0].enabled, true);
  assert.equal(shown.widgets[0].running, false);
});

test("a widget with no anchor is described as the default rather than as nothing", () => {
  const w = describeSettings([{ id: "clock" }], [], [], null).widgets[0];
  assert.equal(w.anchor, "top_right");
  assert.equal(w.offsetX, 0);
  assert.equal(w.enabled, true);
});

test("an anchor the manifest got wrong is described as the one that will actually be used", () => {
  // place() falls back to top_right, so showing "middle" here would be a lie about where the
  // widget is.
  assert.equal(describeSettings([{ id: "clock", anchor: "middle" }], [], [], null).widgets[0].anchor, "top_right");
});

test("junk in the widget list is dropped, not rendered", () => {
  const shown = describeSettings([null, 42, {}, { id: 7 }, { id: "clock" }], [], [], null);
  assert.deepEqual(shown.widgets.map((w) => w.id), ["clock"]);
});

test("nothing at all describes as an empty surface rather than throwing", () => {
  for (const w of [null, undefined, 42, "clock", {}]) {
    const shown = describeSettings(w, null, null, undefined);
    assert.deepEqual(shown.widgets, [], JSON.stringify(w));
    assert.equal(shown.palette, null);
    assert.deepEqual(shown.palettes, []);
  }
});

test("the anchor list handed out is a copy, so a widget cannot edit it for everyone", () => {
  const shown = describeSettings([], [], [], null);
  shown.anchors.push("nowhere");
  assert.equal(ANCHORS.length, 9);
  assert.equal(describeSettings([], [], [], null).anchors.length, 9);
});

// --- the thing this file exists to prove --------------------------------------------------

test("no patch this module can produce writes a capability", () => {
  // The reason a settings surface is allowed to write the config at all. Capabilities are
  // read from a widget.json and never from ~/.hikari/config.json, so this is belt and
  // braces, and it is the belt that is load-bearing if the other layer ever changes.
  const patches = [
    enabledPatch("clock", true, KNOWN),
    anchorPatch("clock", "top_left", KNOWN),
    offsetPatch("clock", 10, 10, KNOWN),
  ];
  const keys = new Set();
  for (const { patch } of patches) {
    assert.deepEqual(Object.keys(patch), ["widgets"]);
    for (const k of Object.keys(patch.widgets.clock)) keys.add(k);
  }
  assert.deepEqual([...keys].sort(), ["anchor", "enabled", "offsetX", "offsetY"]);
  for (const c of ["clipboard", "storage", "launch"]) assert.ok(!keys.has(c), c);
});

test("a patch touches one widget, so switching one off cannot switch another one too", () => {
  const patch = enabledPatch("clock", false, KNOWN).patch;
  const before = { widgets: { clock: { enabled: true, anchor: "top_left" }, todo: { enabled: true } } };
  const after = merge(before, patch);
  assert.equal(after.widgets.clock.enabled, false);
  assert.equal(after.widgets.clock.anchor, "top_left", "the rest of the widget survives the patch");
  assert.equal(after.widgets.todo.enabled, true);
});

// --- palettes arrive in two shapes, and both have to check the same ------------------------

test("a palette list of names and a palette list of objects check identically", () => {
  // The failure this prevents: the picker draws from one list and the check reads the other,
  // so it offers a palette that is then refused.
  const names = ["ember", "frost"];
  const objects = [{ name: "ember", accent: "#f00" }, { name: "frost", accent: "#00f" }];
  for (const list of [names, objects]) {
    assert.deepEqual(paletteChoice("ember", list), { palette: "ember" });
    assert.ok(paletteChoice("sunset", list).error);
  }
});

test("the palettes the surface draws are always the object shape", () => {
  const shown = describeSettings([], [], ["ember", { name: "frost", accent: "#00f", bg: "#001" }], null);
  assert.deepEqual(shown.palettes, [
    { name: "ember", accent: null, bg: null },
    { name: "frost", accent: "#00f", bg: "#001" },
  ]);
});

test("a palette whose file gave up no colours is still listed", () => {
  // A swatch is a convenience; the name is what you pick by. Dropping it would mean a
  // palette that exists on disk and cannot be chosen, with nothing to say why.
  const shown = describeSettings([], [], ["ember"], null);
  assert.equal(shown.palettes.length, 1);
  assert.equal(shown.palettes[0].accent, null);
});

test("junk in the palette list is dropped rather than drawn as a nameless swatch", () => {
  const shown = describeSettings([], [], [null, 42, {}, { accent: "#f00" }, "ember"], null);
  assert.deepEqual(shown.palettes.map((p) => p.name), ["ember"]);
});
