const { test } = require("node:test");
const assert = require("node:assert");
const { themeSources } = require("../src/lib/theme.js");

const has = (...present) => (p) => present.includes(p);

test("the bundled theme alone is the normal case", () => {
  assert.deepStrictEqual(themeSources("/base.css", null, "/user.css", has("/base.css")), ["/base.css"]);
});

test("the user layer comes last, so it overrides", () => {
  // Order is the whole contract: reversed, a user's own colours would lose to the default.
  assert.deepStrictEqual(themeSources("/base.css", null, "/user.css", has("/base.css", "/user.css")), [
    "/base.css",
    "/user.css",
  ]);
});

test("a missing user layer is not an error", () => {
  // Almost nobody has one, so this is the path that runs on most machines.
  assert.deepStrictEqual(themeSources("/base.css", null, "/nope.css", has("/base.css")), ["/base.css"]);
});

test("a user layer with no base still applies", () => {
  // Someone who replaces the theme wholesale should not silently get nothing.
  assert.deepStrictEqual(themeSources("/gone.css", null, "/user.css", has("/user.css")), ["/user.css"]);
});

test("nothing on disk yields nothing, rather than a path that will fail to read", () => {
  assert.deepStrictEqual(themeSources("/gone.css", null, "/nope.css", () => false), []);
});

// --- the palette layer --------------------------------------------------------------------

test("a palette sits between the base and the user", () => {
  // Both halves of that matter. Over the base, or picking a palette would do nothing. Under
  // the user layer, or picking a palette would silently undo a hand-written override, which
  // is the worse of the two because the file is still sitting there looking correct.
  assert.deepStrictEqual(
    themeSources("/base.css", "/p/rain-lantern.css", "/user.css", has("/base.css", "/p/rain-lantern.css", "/user.css")),
    ["/base.css", "/p/rain-lantern.css", "/user.css"],
  );
});

test("no palette chosen is the normal case, not a gap in the list", () => {
  for (const none of [null, undefined, ""]) {
    assert.deepStrictEqual(themeSources("/base.css", none, "/user.css", has("/base.css")), ["/base.css"], String(none));
  }
});

test("a palette that was named but is not on disk is skipped rather than breaking the theme", () => {
  // The host reports that separately. Dropping the whole theme because one layer is missing
  // would turn a wrong colour into an unstyled widget, which looks broken rather than plain.
  assert.deepStrictEqual(themeSources("/base.css", "/p/gone.css", "/user.css", has("/base.css", "/user.css")), [
    "/base.css",
    "/user.css",
  ]);
});

test("a palette with no base and no user layer is still applied", () => {
  assert.deepStrictEqual(themeSources("/gone.css", "/p/x.css", "/nope.css", has("/p/x.css")), ["/p/x.css"]);
});
