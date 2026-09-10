const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseAccelerator, canonical, plan } = require("../src/lib/hotkeys");

const ok = (s) => {
  const r = parseAccelerator(s);
  assert.ok(r.ok, `${s} should parse, got: ${r.reason}`);
  return r;
};
const bad = (s) => {
  const r = parseAccelerator(s);
  assert.ok(!r.ok, `${s} should be refused`);
  return r.reason;
};

test("a plain modifier and key parses", () => {
  const r = ok("CommandOrControl+Shift+K");
  assert.deepEqual(r.modifiers, ["commandorcontrol", "shift"]);
  assert.equal(r.key, "k");
});

test("case does not matter, because Electron's grammar is case insensitive", () => {
  assert.equal(canonical(ok("ctrl+shift+k")), canonical(ok("Shift+Control+K")));
});

test("every key family Electron documents is accepted", () => {
  // A list that is too short refuses a shortcut that would have worked, and the user cannot
  // tell that from the key itself being broken.
  for (const k of ["0", "9", "a", "Z", "F1", "F24", "Space", "Esc", "Enter", "PageDown",
                   "MediaPlayPause", "PrintScreen", "num0", "num9", "numdec", "numdiv",
                   "Plus", "/", "\\", "`", "]", '"', "-"]) {
    ok(`Alt+${k}`);
  }
});

test("F25 is not a key, so the range is a real range and not a prefix match", () => {
  bad("Alt+F25");
  bad("Alt+F0");
});

test("a shortcut with no modifier is refused, because it would be taken from every app", () => {
  assert.match(bad("K"), /at least one modifier/);
});

test("a misspelled modifier is named in the reason", () => {
  // "Ctrl+Shft+K" is a one-character typo; a message about the whole accelerator sends the
  // reader looking at the key.
  assert.match(bad("Ctrl+Shft+K"), /"shft" is not a modifier/);
});

test("an unknown key is named in the reason", () => {
  assert.match(bad("Ctrl+Banana"), /"banana" is not a key/);
});

test("a literal plus says to write Plus, rather than being read as an empty key", () => {
  assert.match(bad("Ctrl++"), /"Plus"/);
});

test("the same modifier under two names is a typo, not two modifiers", () => {
  assert.match(bad("Ctrl+Control+K"), /named twice/);
  assert.match(bad("Cmd+Command+K"), /named twice/);
  assert.match(bad("Alt+Option+K"), /named twice/);
});

test("a modifier after the key is refused", () => {
  // Only the last part may be a key, so "K+Ctrl" has "k" where a modifier belongs.
  assert.match(bad("K+Ctrl"), /not a modifier/);
});

test("nothing at all is refused rather than throwing", () => {
  for (const v of [undefined, null, 42, "", "   ", {}]) {
    assert.equal(parseAccelerator(v).ok, false, String(v));
  }
});

test("a widget with no hotkey is not a problem, it is just not bound", () => {
  const { bindings, problems } = plan([{ id: "clock", manifest: {} }]);
  assert.deepEqual(bindings, []);
  assert.deepEqual(problems, []);
});

test("a valid hotkey becomes a binding", () => {
  const { bindings, problems } = plan([{ id: "decoder", manifest: { hotkey: "Alt+Space" } }]);
  assert.deepEqual(problems, []);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].id, "decoder");
  assert.equal(bindings[0].accelerator, "Alt+Space");
});

test("a broken hotkey is reported, and does not stop the others binding", () => {
  const { bindings, problems } = plan([
    { id: "a", manifest: { hotkey: "Ctrl+Banana" } },
    { id: "b", manifest: { hotkey: "Alt+Space" } },
  ]);
  assert.deepEqual(bindings.map((b) => b.id), ["b"]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].id, "a");
});

test("two widgets asking for the same shortcut: the first wins and the second is told who has it", () => {
  const { bindings, problems } = plan([
    { id: "first", manifest: { hotkey: "Ctrl+Shift+K" } },
    { id: "second", manifest: { hotkey: "shift+control+k" } },
  ]);
  assert.deepEqual(bindings.map((b) => b.id), ["first"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /"first" already asked/);
});

test("a duplicate is detected across spelling, not by string equality", () => {
  // Registering both would mean one of them never fires, with nothing to say which.
  const { bindings } = plan([
    { id: "first", manifest: { hotkey: "CmdOrCtrl+Alt+J" } },
    { id: "second", manifest: { hotkey: "Option+CommandOrControl+j" } },
  ]);
  assert.equal(bindings.length, 1);
});

test("different shortcuts both bind", () => {
  const { bindings, problems } = plan([
    { id: "a", manifest: { hotkey: "Alt+1" } },
    { id: "b", manifest: { hotkey: "Alt+2" } },
  ]);
  assert.deepEqual(problems, []);
  assert.equal(bindings.length, 2);
});
