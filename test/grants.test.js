const { test } = require("node:test");
const assert = require("node:assert/strict");
const { granted, CAPABILITIES } = require("../src/lib/grants");

// The refusals are the design. The grant is one line and the refusals are why the line is
// safe, so they are what these tests are about.

test("a widget that asked for it is granted", () => {
  assert.equal(granted({ clipboard: true }, "clipboard"), true);
});

test("a widget that did not ask is refused", () => {
  assert.equal(granted({}, "clipboard"), false);
  assert.equal(granted({ clipboard: false }, "clipboard"), false);
});

test("an unknown window is refused rather than throwing", () => {
  // manifests.get() on an id the host does not know returns undefined, and that has to be
  // a refusal: a window nobody can identify is the one to trust least.
  assert.equal(granted(undefined, "clipboard"), false);
  assert.equal(granted(null, "clipboard"), false);
});

test("a truthy value that is not true is refused", () => {
  // "clipboard": "false" is a string and truthy. A permission that turns itself on when you
  // try to write it off is the worst direction for this mistake.
  for (const v of ["false", "true", 1, "yes", {}, [], "1"]) {
    assert.equal(granted({ clipboard: v }, "clipboard"), false, JSON.stringify(v));
  }
});

test("a capability the host does not define throws, rather than reading as not asked for", () => {
  // Otherwise a typo in the host's own code looks like a widget that had not asked, and the
  // fix gets looked for in the manifest.
  assert.throws(() => granted({ clipbaord: true }, "clipbaord"), /unknown capability/);
  assert.throws(() => granted({ netwrok: true }, "netwrok"), /unknown capability/);
});

test("prototype keys are not capabilities", () => {
  assert.throws(() => granted({}, "constructor"), /unknown capability/);
  assert.throws(() => granted({}, "toString"), /unknown capability/);
});

test("the capability list is not empty, so these tests cannot pass by covering nothing", () => {
  assert.ok(CAPABILITIES.has("clipboard"));
  assert.ok(CAPABILITIES.has("storage"));
  assert.ok(CAPABILITIES.has("launch"));
});

test("storage is a capability, and it is not a licence to write anywhere", () => {
  // The check is the same shape as the clipboard's. What makes storage safe is not this
  // function, it is that there is no path parameter anywhere in the call it guards: see
  // src/lib/store.js.
  assert.equal(granted({ storage: true }, "storage"), true);
  assert.equal(granted({ storage: "true" }, "storage"), false);
  assert.equal(granted({ clipboard: true }, "storage"), false);
  assert.equal(granted({}, "storage"), false);
  assert.equal(granted(undefined, "storage"), false);
});

test("asking for one capability does not grant the other", () => {
  // A widget that stores a list has no business reading the clipboard, and the other way
  // round. Two names, two answers.
  assert.equal(granted({ storage: true }, "clipboard"), false);
  assert.equal(granted({ clipboard: true }, "storage"), false);
});

test("launch is a capability, and it is not a licence to run anything", () => {
  // The sharpest one. What makes it safe is not this check, it is that the call it guards
  // takes an id from the user's own config and has no parameter for a target: see
  // src/lib/launch.js.
  assert.equal(granted({ launch: true }, "launch"), true);
  assert.equal(granted({ launch: "true" }, "launch"), false);
  assert.equal(granted({}, "launch"), false);
  assert.equal(granted(undefined, "launch"), false);
});

test("no capability implies any other", () => {
  // A wallpaper shader that reads the clipboard must not thereby be able to start a program,
  // and a dock must not be able to read the clipboard. Three names, three answers.
  const all = ["clipboard", "storage", "launch"];
  for (const held of all) {
    for (const asked of all) {
      assert.equal(granted({ [held]: true }, asked), held === asked, `${held} -> ${asked}`);
    }
  }
});
