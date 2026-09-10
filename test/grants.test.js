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
  assert.throws(() => granted({ launch: true }, "launch"), /unknown capability/);
});

test("prototype keys are not capabilities", () => {
  assert.throws(() => granted({}, "constructor"), /unknown capability/);
  assert.throws(() => granted({}, "toString"), /unknown capability/);
});

test("the capability list is not empty, so these tests cannot pass by covering nothing", () => {
  assert.ok(CAPABILITIES.has("clipboard"));
});
