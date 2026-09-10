const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");

// The host imports electron at module load. Stub it so the pure geometry and discovery
// logic can be tested without a browser runtime, which is the point of keeping them pure.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => "/nonexistent-home", whenReady: () => ({ then() {} }), on() {} },
      BrowserWindow: class {},
      ipcMain: { handle() {} },
          screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    };
  }
  return origLoad.apply(this, arguments);
};
const { place, discover } = require("../src/main.js");

const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };

test("top_right anchors against the work area, not the screen", () => {
  const r = place({ workArea: { x: 0, y: 40, width: 1920, height: 1040 } },
                  { anchor: "top_right", width: 200, height: 100, margin: 20 });
  assert.strictEqual(r.x, 1700);
  assert.strictEqual(r.y, 60); // 40 of taskbar + 20 margin
});

test("bottom_left sits above the bottom edge by the margin", () => {
  const r = place(display, { anchor: "bottom_left", width: 200, height: 100, margin: 16 });
  assert.strictEqual(r.x, 16);
  assert.strictEqual(r.y, 1080 - 100 - 16);
});

test("middle_center centres on both axes", () => {
  const r = place(display, { anchor: "middle_center", width: 200, height: 100 });
  assert.strictEqual(r.x, (1920 - 200) / 2);
  assert.strictEqual(r.y, (1080 - 100) / 2);
});

test("offsets stack on top of the anchor", () => {
  const base = place(display, { anchor: "top_right", width: 200, height: 100, margin: 20 });
  const off = place(display, { anchor: "top_right", width: 200, height: 100, margin: 20, offsetY: 128 });
  assert.strictEqual(off.y, base.y + 128);
});

test("a second monitor's origin is respected", () => {
  const r = place({ workArea: { x: 1920, y: 0, width: 1280, height: 720 } },
                  { anchor: "top_left", width: 100, height: 50, margin: 10 });
  assert.strictEqual(r.x, 1930);
});

test("defaults apply when a manifest omits everything", () => {
  const r = place(display, {});
  assert.strictEqual(r.width, 300);
  assert.strictEqual(r.height, 120);
  assert.ok(r.x > 0 && r.y > 0);
});

test("discover finds the bundled widgets and skips a disabled one", () => {
  const found = discover().map((w) => w.id).sort();
  assert.deepStrictEqual(found, ["audio-visualizer", "clock", "companion", "media", "nowplaying", "shader", "stats"]);
});

test("fill:screen covers the whole display, not the work area", () => {
  // A wallpaper belongs behind the taskbar, so it must ignore the work area inset.
  const r = place({ bounds: { x: 0, y: 0, width: 1920, height: 1080 },
                    workArea: { x: 0, y: 40, width: 1920, height: 1040 } },
                  { fill: "screen" });
  assert.deepStrictEqual(r, { x: 0, y: 0, width: 1920, height: 1080 });
});

test("fill:screen respects a second monitor's origin", () => {
  const r = place({ bounds: { x: 1920, y: -200, width: 1280, height: 720 },
                    workArea: { x: 1920, y: -160, width: 1280, height: 680 } },
                  { fill: "screen" });
  assert.strictEqual(r.x, 1920);
  assert.strictEqual(r.y, -200);
});
