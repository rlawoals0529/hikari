const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ACTIONS, readAction, readShortcuts, merge } = require("../src/lib/shortcuts");
const { plan } = require("../src/lib/hotkeys");

const WIDGETS = ["decoder", "todo", "weather"];
const DOCK = ["steam", "code"];
const read = (map) => readShortcuts(map, WIDGETS, DOCK);

test("an action is a verb and a name", () => {
  assert.deepEqual(readAction("toggle:decoder"), { verb: "toggle", target: "decoder" });
  assert.deepEqual(readAction("refresh"), { verb: "refresh", target: null });
});

test("whitespace around either part is forgiven", () => {
  assert.deepEqual(readAction("  toggle: decoder  "), { verb: "toggle", target: "decoder" });
});

test("every documented verb works", () => {
  for (const [verb, spec] of Object.entries(ACTIONS)) {
    const action = spec.needsTarget ? `${verb}:decoder` : verb;
    // launch takes a dock id, so readAction only checks the shape here.
    assert.ok(!readAction(action).error, `${action}: ${readAction(action).error}`);
  }
});

test("an unknown verb is refused and the real ones are listed", () => {
  // A typo is otherwise a key that does nothing and a config that looks correct.
  const e = readAction("togle:decoder").error;
  assert.match(e, /"togle" is not an action/);
  assert.match(e, /toggle, reload, launch, refresh, hideAll/);
});

test("a verb that needs a target and has none is refused", () => {
  assert.match(readAction("toggle").error, /needs a widget id/);
  assert.match(readAction("toggle:").error, /needs a widget id/);
  assert.match(readAction("launch:  ").error, /needs a dock entry id/);
});

test("a target on a verb that takes none is refused rather than dropped", () => {
  // Somebody wrote refresh:weather expecting one provider to refresh, and dropping the
  // target quietly would give them a key that refreshes everything.
  assert.match(readAction("refresh:weather").error, /takes no target/);
});

test("a target must be a name, not a path or a command", () => {
  for (const t of ["../x", "a/b", "a b", "A", "rm -rf /", "a;b", "a:b"]) {
    assert.ok(readAction(`toggle:${t}`).error, t);
  }
});

test("nothing at all is refused rather than throwing", () => {
  for (const v of [null, undefined, "", "   ", 42, {}, []]) {
    assert.ok(readAction(v).error, JSON.stringify(v));
  }
});

test("a whole map reads into bindings", () => {
  const { bindings, problems } = read({
    "Alt+Space": "toggle:decoder",
    "CommandOrControl+Alt+S": "launch:steam",
    "Alt+R": "refresh",
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(bindings.map((b) => `${b.verb}${b.target ? ":" + b.target : ""}`), [
    "toggle:decoder",
    "launch:steam",
    "refresh",
  ]);
});

test("a bad accelerator is reported with the reason, not just skipped", () => {
  const { bindings, problems } = read({ "Alt+Space": "refresh", K: "refresh", "Ctrl+Shft+J": "refresh" });
  assert.equal(bindings.length, 1);
  assert.match(problems.join(" "), /at least one modifier/);
  assert.match(problems.join(" "), /"shft" is not a modifier/);
});

test("a shortcut naming a widget that does not exist is refused at startup", () => {
  // The whole point. Binding it would give a key that fails when pressed, and a key that
  // does nothing is indistinguishable from a broken app.
  const { bindings, problems } = read({ "Alt+X": "toggle:nosuchwidget" });
  assert.equal(bindings.length, 0);
  assert.match(problems[0], /names widget "nosuchwidget", which does not exist/);
  assert.match(problems[0], /Known: decoder, todo, weather/);
});

test("a shortcut launching something that is not in the dock is refused", () => {
  const { problems } = read({ "Alt+X": "launch:notinthedock" });
  assert.match(problems[0], /is not a dock entry/);
  assert.match(problems[0], /Known: steam, code/);
});

test("with nothing loaded the message says so rather than listing nothing", () => {
  assert.match(readShortcuts({ "Alt+X": "toggle:decoder" }, [], []).problems[0], /no widgets are loaded/);
  assert.match(readShortcuts({ "Alt+X": "launch:steam" }, [], []).problems[0], /the dock is empty/);
});

test("a verb with no target is not checked against anything, so it always binds", () => {
  const { bindings, problems } = readShortcuts({ "Alt+R": "refresh", "Alt+H": "hideAll" }, [], []);
  assert.equal(bindings.length, 2);
  assert.deepEqual(problems, []);
});

test("two spellings of one key in the same map: the second is reported", () => {
  const { bindings, problems } = read({ "Ctrl+Alt+J": "refresh", "alt+control+j": "hideAll" });
  assert.equal(bindings.length, 1);
  assert.match(problems[0], /is the same key as/);
});

test("a config that is not a map is no shortcuts, not a throw", () => {
  for (const c of [null, undefined, [], 42, "Alt+X", true]) {
    assert.deepEqual(readShortcuts(c, WIDGETS, DOCK).bindings, [], JSON.stringify(c));
  }
});

test("a prototype key in the map is treated as a key, not as inheritance", () => {
  // Object.entries only walks own enumerable keys, which is what makes this safe. Pinned
  // because switching to a for..in loop would quietly change that.
  const { bindings, problems } = read({ __proto__: "refresh", "Alt+R": "refresh" });
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].accelerator, "Alt+R");
  assert.equal(problems.length, 0);
});

// --- merging with the widgets' own hotkeys ----------------------------------------------

const widgetBindings = plan([
  { id: "decoder", manifest: { hotkey: "Alt+Space" } },
  { id: "todo", manifest: { hotkey: "Alt+T" } },
]).bindings;

test("a widget hotkey with no shortcut competing for it becomes a toggle", () => {
  const { bindings, problems } = merge(widgetBindings, []);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    bindings.map((b) => `${b.from}:${b.verb}:${b.target}`).sort(),
    ["widget:toggle:decoder", "widget:toggle:todo"],
  );
});

test("the user's map wins over a widget's own hotkey, and the widget is told", () => {
  // They wrote it more recently and more deliberately than a widget author chose a default.
  // Reported rather than dropped, because a key that mysteriously stopped working is worse
  // than a considered override.
  const { bindings: mine } = read({ "Alt+Space": "launch:steam" });
  const { bindings, problems } = merge(widgetBindings, mine);
  const forSpace = bindings.find((b) => b.canonical === "alt+space");
  assert.equal(forSpace.from, "config");
  assert.equal(forSpace.verb, "launch");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /widget "decoder" wants Alt\+Space/);
  assert.match(problems[0], /Yours wins/);
});

test("an override is detected across spelling, not by string equality", () => {
  const { bindings: mine } = read({ "space+alt": "refresh" });
  // "space+alt" has the key first, so it is not a valid accelerator at all.
  assert.equal(mine.length, 0);
  const { bindings: real } = read({ "ALT+SPACE": "refresh" });
  const { problems } = merge(widgetBindings, real);
  assert.equal(problems.length, 1, "a differently-spelled same key must still clash");
});

test("everything that survives is one binding per key", () => {
  const { bindings: mine } = read({ "Alt+Space": "refresh", "Alt+R": "hideAll" });
  const { bindings } = merge(widgetBindings, mine);
  const keys = bindings.map((b) => b.canonical);
  assert.equal(new Set(keys).size, keys.length);
});

test("every binding carries a verb and a target, whichever it came from", () => {
  // The host has one branch to write rather than two, which is why a widget hotkey is
  // normalised into a toggle rather than kept as a separate shape.
  const { bindings: mine } = read({ "Alt+R": "refresh" });
  for (const b of merge(widgetBindings, mine).bindings) {
    assert.ok(typeof b.verb === "string", JSON.stringify(b));
    assert.ok(b.target === null || typeof b.target === "string");
    assert.ok(b.from === "widget" || b.from === "config");
  }
});
