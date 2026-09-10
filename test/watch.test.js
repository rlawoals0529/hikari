const { test } = require("node:test");
const assert = require("node:assert/strict");
const { changed } = require("../src/lib/watch");

test("a manifest edit is a manifest edit", () => {
  assert.deepEqual(changed("clock/widget.json"), { folder: "clock", manifest: true });
});

test("a page edit names the widget but is not a manifest edit", () => {
  assert.deepEqual(changed("clock/index.html"), { folder: "clock", manifest: false });
});

test("a file nested deeper still belongs to the widget at the top", () => {
  assert.deepEqual(changed("shader/shaders/aurora.frag"), { folder: "shader", manifest: false });
});

test("windows separators work, because that is where this app is aimed", () => {
  assert.deepEqual(changed("shader\\shaders\\aurora.frag"), { folder: "shader", manifest: false });
  assert.deepEqual(changed("clock\\widget.json"), { folder: "clock", manifest: true });
});

test("a file in the root belongs to no widget", () => {
  // widgets/theme.css is shared, so it is not one window's business.
  assert.equal(changed("theme.css"), null);
  assert.equal(changed("./theme.css"), null);
});

test("a path that leaves the root is refused rather than resolved", () => {
  // The return value picks a window to reload, so a path that is not under the root has to
  // select nothing at all.
  assert.equal(changed("../secret/widget.json"), null);
  assert.equal(changed("clock/../../etc/passwd"), null);
});

test("nothing is nothing, rather than a throw", () => {
  for (const v of [null, undefined, "", "   ", 7, {}]) assert.equal(changed(v), null, String(v));
});

test("a widget.json somewhere deeper is still treated as a manifest", () => {
  // fs.watch only reports what exists, so this is about the rule being on the basename
  // rather than on the depth.
  assert.deepEqual(changed("a/b/widget.json"), { folder: "a", manifest: true });
});
