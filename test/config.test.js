const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  MIN_INTERVAL_MS,
  merge,
  coerce,
  fromQuery,
  widgetConfig,
  providerConfig,
  providerInterval,
} = require("../src/lib/config");

test("a later layer wins one key at a time, it does not replace the object", () => {
  assert.deepEqual(merge({ a: 1, b: 2 }, { b: 3 }), { a: 1, b: 3 });
});

test("nested objects merge rather than replace", () => {
  assert.deepEqual(
    merge({ pos: { x: 1, y: 2 }, w: 10 }, { pos: { y: 9 } }),
    { pos: { x: 1, y: 9 }, w: 10 },
  );
});

test("an array replaces whole, so a default entry can be removed", () => {
  assert.deepEqual(merge({ apps: ["steam", "league"] }, { apps: ["steam"] }), { apps: ["steam"] });
});

test("a present null clears a default", () => {
  assert.deepEqual(merge({ source: "cat.gif" }, { source: null }), { source: null });
});

test("an absent key leaves the default alone", () => {
  assert.deepEqual(merge({ source: "cat.gif" }, {}), { source: "cat.gif" });
});

test("merge does not mutate either input", () => {
  const base = { pos: { x: 1 } };
  const over = { pos: { x: 2 } };
  merge(base, over);
  assert.deepEqual(base, { pos: { x: 1 } });
  assert.deepEqual(over, { pos: { x: 2 } });
});

test("a query value that reads as false is a boolean, not the truthy string", () => {
  assert.equal(coerce("false"), false);
  assert.equal(coerce("true"), true);
});

test("a bare key means true", () => {
  assert.equal(coerce(""), true);
});

test("a number is a number", () => {
  assert.equal(coerce("30"), 30);
  assert.equal(coerce("-2.5"), -2.5);
});

test("something that is not a complete number stays a string", () => {
  // Anything that becomes NaN or Infinity would reach a widget as a number and render.
  for (const s of ["3 kg", "1e999", "0x10", "12px", "", " 3"]) {
    if (s === "") continue;
    assert.equal(typeof coerce(s), "string", s);
  }
});

test("a whole query string becomes a config object", () => {
  assert.deepEqual(fromQuery("?shader=aurora&fps=30&loop=false"), {
    shader: "aurora",
    fps: 30,
    loop: false,
  });
});

test("no query string is an empty config, not a throw", () => {
  assert.deepEqual(fromQuery(""), {});
  assert.deepEqual(fromQuery(undefined), {});
});

test("a repeated key collects into an array", () => {
  assert.deepEqual(fromQuery("?tag=a&tag=b&tag=c"), { tag: ["a", "b", "c"] });
});

test("the user config overrides the widget's own defaults", () => {
  const manifest = { anchor: "top_right", width: 300 };
  const user = { widgets: { clock: { anchor: "bottom_left" } } };
  assert.deepEqual(widgetConfig(manifest, user, "clock"), { anchor: "bottom_left", width: 300 });
});

test("a live edit beats the user config, which beats the manifest", () => {
  const manifest = { fps: 60 };
  const user = { widgets: { shader: { fps: 30 } } };
  assert.equal(widgetConfig(manifest, user, "shader", { fps: 24 }).fps, 24);
});

test("another widget's overrides do not reach this one", () => {
  const user = { widgets: { stats: { anchor: "bottom_left" } } };
  assert.deepEqual(widgetConfig({ anchor: "top_right" }, user, "clock"), { anchor: "top_right" });
});

test("no user config at all is the normal case", () => {
  assert.deepEqual(widgetConfig({ width: 300 }, null, "clock"), { width: 300 });
  assert.deepEqual(widgetConfig({ width: 300 }, {}, "clock"), { width: 300 });
});

test("a provider reads its own block and nobody else's", () => {
  const user = { providers: { weather: { latitude: 51.5 }, cpu: { intervalMs: 5000 } } };
  assert.deepEqual(providerConfig({ name: "weather", defaults: { units: "metric" } }, user), {
    units: "metric",
    latitude: 51.5,
  });
});

test("a provider with no defaults and no override gets an empty config", () => {
  assert.deepEqual(providerConfig({ name: "cpu" }, null), {});
});

test("the user's interval wins over the provider's", () => {
  assert.equal(providerInterval({ name: "cpu", intervalMs: 2000 }, { intervalMs: 5000 }), 5000);
});

test("an interval below the floor is clamped, not honoured", () => {
  assert.equal(providerInterval({ name: "cpu", intervalMs: 2000 }, { intervalMs: 1 }), MIN_INTERVAL_MS);
});

test("an unusable interval falls back to the provider's own, never to zero", () => {
  for (const bad of [undefined, null, "soon", 0, -5, NaN]) {
    assert.equal(providerInterval({ name: "cpu", intervalMs: 2000 }, { intervalMs: bad }), 2000, String(bad));
  }
});

test("the result never aliases a nested object inside the override", () => {
  // Otherwise a widget holds a live reference into ~/.hikari/config.json, and one write
  // edits the user's own settings for every other widget.
  const user = { widgets: { clock: { pos: { x: 1 } } } };
  const cfg = widgetConfig({}, user, "clock");
  cfg.pos.x = 99;
  assert.equal(user.widgets.clock.pos.x, 1);
});

// --- a name out of a directory listing is not a safe object key ---------------------------

test("a widget in a directory named after a prototype member keeps its manifest", () => {
  // This was a real fault, and it was silent. `userConfig.widgets[id]` reached the
  // prototype for `constructor` and `toString`, merge saw a function rather than a plain
  // object and returned it whole, and the manifest was replaced: the widget ended up with
  // `{}`, so no html, no size, no anchor, and nothing said about why it drew nothing.
  const manifest = { html: "index.html", width: 200, anchor: "top_left" };
  for (const id of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.deepStrictEqual(widgetConfig(manifest, { widgets: {} }, id), manifest, id);
  }
});

test("the same for a provider name", () => {
  for (const name of ["constructor", "toString", "valueOf"]) {
    assert.deepStrictEqual(providerConfig({ name, defaults: { intervalMs: 1000 } }, { providers: {} }), {
      intervalMs: 1000,
    });
  }
});

test("an override with that name still applies when it is really there", () => {
  // The fix must not become a blocklist: a widget genuinely called `constructor` is
  // configurable like any other.
  const got = widgetConfig({ width: 200 }, { widgets: { constructor: { width: 400 } } }, "constructor");
  assert.strictEqual(got.width, 400);
});

test("an override that is not an object is ignored rather than replacing the manifest", () => {
  // `"widgets": {"clock": 3}` is a plausible typo, and before the fix it made the manifest
  // the number 3.
  for (const bad of [3, "wide", true, null, ["a"]]) {
    assert.deepStrictEqual(widgetConfig({ width: 200 }, { widgets: { clock: bad } }, "clock"), { width: 200 }, JSON.stringify(bad));
  }
});

test("a widgets block that is not an object is no overrides, not a throw", () => {
  for (const bad of [3, "x", true, null, ["a"]]) {
    assert.deepStrictEqual(widgetConfig({ width: 200 }, { widgets: bad }, "clock"), { width: 200 }, JSON.stringify(bad));
  }
});

test("the type check is the half that fixes it", () => {
  // Said out loud because a mutation proved it: putting the bare `bag[name]` back changes
  // nothing, since every prototype member here is a function and a function is not a plain
  // object. This is the assertion that turns red when the type check goes.
  const manifest = { html: "index.html", width: 200 };
  assert.deepStrictEqual(widgetConfig(manifest, { widgets: {} }, "constructor"), manifest);
  assert.deepStrictEqual(widgetConfig(manifest, { widgets: { clock: 3 } }, "clock"), manifest);
});

test("and the own-property read is the half that survives a polluted prototype", () => {
  // `__proto__` is the one prototype member that is a plain object, so it passes the type
  // check. With nothing on Object.prototype that is harmless, because merge walks own keys
  // and there are none -- but that is a fact about a global any dependency can change, so
  // this pins the behaviour under exactly that condition rather than trusting it.
  const manifest = { html: "index.html", width: 200 };
  Object.defineProperty(Object.prototype, "width", { value: 9999, enumerable: true, configurable: true });
  try {
    assert.deepStrictEqual(widgetConfig(manifest, { widgets: {} }, "__proto__"), manifest);
    assert.deepStrictEqual(widgetConfig(manifest, { widgets: {} }, "clock"), manifest);
  } finally {
    delete Object.prototype.width;
  }
  assert.ok(!("width" in Object.prototype), "the pollution must not outlive this test");
});
