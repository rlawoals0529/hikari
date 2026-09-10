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
