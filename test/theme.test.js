const { test } = require("node:test");
const assert = require("node:assert");
const { themeSources } = require("../src/lib/theme.js");

const has = (...present) => (p) => present.includes(p);

test("the bundled theme alone is the normal case", () => {
  assert.deepStrictEqual(themeSources("/base.css", "/user.css", has("/base.css")), ["/base.css"]);
});

test("the user layer comes second, so it overrides", () => {
  // Order is the whole contract: reversed, a user's palette would lose to the default.
  assert.deepStrictEqual(
    themeSources("/base.css", "/user.css", has("/base.css", "/user.css")),
    ["/base.css", "/user.css"],
  );
});

test("a missing user layer is not an error", () => {
  // Almost nobody has one, so this is the path that runs on most machines.
  assert.deepStrictEqual(themeSources("/base.css", "/nope.css", has("/base.css")), ["/base.css"]);
});

test("a user layer with no base still applies", () => {
  // Someone who replaces the theme wholesale should not silently get nothing.
  assert.deepStrictEqual(themeSources("/gone.css", "/user.css", has("/user.css")), ["/user.css"]);
});

test("nothing on disk yields nothing, rather than a path that will fail to read", () => {
  assert.deepStrictEqual(themeSources("/gone.css", "/nope.css", () => false), []);
});
