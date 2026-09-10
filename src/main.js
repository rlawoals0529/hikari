/**
 * Widget host.
 *
 * Every widget is a folder with a `widget.json` and an `index.html`. The host turns each
 * into a transparent, frameless, always-on-top window, then broadcasts provider output to
 * all of them on a shared tick. Widgets are plain web pages; nothing here is bound to a
 * window manager, which is the whole reason this exists.
 */
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { providers } = require("./providers");
const { control } = require("./providers/media");

const WIDGET_DIRS = [
  path.join(__dirname, "..", "widgets"),
  path.join(app.getPath("home"), ".hikari", "widgets"),
];

const windows = new Map();
const manifests = new Map();
const state = {};

/** Anchors are resolved against the work area, so a taskbar never overlaps a widget. */
function place(display, manifest) {
  // A wallpaper covers the whole display, bounds not work area: it belongs *behind* the
  // taskbar, not beside it.
  if (manifest.fill === "screen") {
    const b = display.bounds;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  const { x, y, width: dw, height: dh } = display.workArea;
  const w = manifest.width ?? 300;
  const h = manifest.height ?? 120;
  const m = manifest.margin ?? 16;
  const [v, hAlign] = (manifest.anchor ?? "top_right").split("_");
  const left = hAlign === "left" ? x + m : hAlign === "center" ? x + (dw - w) / 2 : x + dw - w - m;
  const top = v === "top" ? y + m : v === "middle" ? y + (dh - h) / 2 : y + dh - h - m;
  return { x: Math.round(left + (manifest.offsetX ?? 0)), y: Math.round(top + (manifest.offsetY ?? 0)), width: w, height: h };
}

function discover() {
  const found = [];
  for (const root of WIDGET_DIRS) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      const manifestPath = path.join(dir, "widget.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (manifest.enabled === false) continue;
        found.push({ id: manifest.name ?? name, dir, manifest });
      } catch (e) {
        // A widget with broken JSON is skipped loudly. Silently dropping it is how you
        // spend ten minutes wondering why one widget never appears.
        console.error(`[hikari] ${name}/widget.json is not valid JSON: ${e.message}`);
      }
    }
  }
  return found;
}

function createWidget({ id, dir, manifest }) {
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...place(display, manifest),
    frame: false,
    transparent: true,
    resizable: false,
    movable: manifest.movable ?? false,
    skipTaskbar: true,
    focusable: manifest.interactive ?? false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // A widget never receives a click, so the default policy would leave every
      // AudioContext suspended and any audio-reactive widget frozen at silence.
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  if (manifest.layer === "wallpaper") {
    // Behind everything, and out of the alt-tab and window lists.
    win.setAlwaysOnTop(false);
    win.setIgnoreMouseEvents(true, { forward: true });
    if (process.platform === "darwin") win.setWindowButtonVisibility?.(false);
  } else {
    // "screen-saver" is the level that actually stays above a maximised window; plain
    // alwaysOnTop loses to fullscreen apps on every platform.
    win.setAlwaysOnTop(true, "screen-saver");
  }
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // A non-interactive widget must not eat clicks meant for the desktop behind it.
  if (!manifest.interactive) win.setIgnoreMouseEvents(true, { forward: true });

  // A widget reads its own manifest through hikari.config(). Keyed by webContents id so
  // two widgets from the same folder cannot read each other's settings.
  manifests.set(win.webContents.id, manifest);

  win.loadFile(path.join(dir, "index.html"));
  win.once("ready-to-show", () => win.show());
  windows.set(id, win);
  return win;
}

function broadcast() {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send("hikari:state", state);
  }
}

function startProviders() {
  for (const p of providers) {
    const tick = async () => {
      try {
        state[p.name] = await p.read();
        broadcast();
      } catch (e) {
        console.error(`[hikari] provider "${p.name}" failed: ${e.message}`);
      }
    };
    tick();
    setInterval(tick, p.intervalMs).unref?.();
  }
}

app.whenReady().then(() => {
  ipcMain.handle("hikari:media", (_e, action) => control(action));
  ipcMain.handle("hikari:state", () => state);
  ipcMain.handle("hikari:config", (e) => manifests.get(e.sender.id) ?? {});

  const widgets = discover();
  if (widgets.length === 0) {
    console.error(`[hikari] no widgets found. Looked in:\n  ${WIDGET_DIRS.join("\n  ")}`);
    app.quit();
    return;
  }
  for (const w of widgets) createWidget(w);
  console.log(`[hikari] ${widgets.length} widget(s): ${widgets.map((w) => w.id).join(", ")}`);
  startProviders();
});

app.on("window-all-closed", () => app.quit());

module.exports = { place, discover };
