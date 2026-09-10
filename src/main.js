/**
 * Widget host.
 *
 * Every widget is a folder with a `widget.json` and an `index.html`. The host turns each
 * into a transparent, frameless, always-on-top window, then broadcasts provider output to
 * all of them on a shared tick. Widgets are plain web pages; nothing here is bound to a
 * window manager, which is the whole reason this exists.
 */
const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { providers } = require("./providers");
const { control } = require("./providers/media");
const { themeSources } = require("./lib/theme");
const { widgetConfig, providerConfig, providerInterval, MIN_INTERVAL_MS } = require("./lib/config");
const { plan } = require("./lib/hotkeys");
const { granted, capabilitiesFrom } = require("./lib/grants");
const { changed } = require("./lib/watch");
const { statePath, readState, writable } = require("./lib/store");
const { readEntries, resolveTarget } = require("./lib/launch");
const { readShortcuts, merge: mergeShortcuts } = require("./lib/shortcuts");

/**
 * Where settings, the user's theme layer and the user's own widgets live.
 *
 * `HIKARI_HOME` overrides it, which is how the host gets run against a throwaway config
 * instead of the one you use. `$HOME` cannot do that job: on macOS `app.getPath("home")`
 * asks the OS and ignores `$HOME` entirely, so a run with `HOME` pointed elsewhere silently
 * read the real directory and reported that it had found nothing wrong. Verified against
 * Electron 33: `getPath("home")` returned the real home while `os.homedir()` returned the
 * override. Switching to `os.homedir()` would fix the test and change what a real install
 * reads, so the override is explicit instead.
 */
const HIKARI_HOME = process.env.HIKARI_HOME
  ? path.resolve(process.env.HIKARI_HOME)
  : path.join(app.getPath("home"), ".hikari");
const WIDGET_DIRS = [path.join(__dirname, "..", "widgets"), path.join(HIKARI_HOME, "widgets")];

const BASE_THEME = path.join(__dirname, "..", "widgets", "theme.css");
const USER_THEME = path.join(HIKARI_HOME, "theme.css");
const USER_CONFIG = path.join(HIKARI_HOME, "config.json");

const windows = new Map();
const manifests = new Map();
/**
 * webContents id -> the capabilities that widget's own widget.json asked for.
 *
 * Kept apart from `manifests` on purpose. A manifest is merged with the user's config,
 * which is right for layout and wrong for authority: see `capabilitiesFrom`.
 */
const capabilities = new Map();
/** id -> { id, dir, onDisk, win }. What a re-merge needs: the untouched manifest and the window. */
const registry = new Map();
const state = {};

/** The user's overrides. Every layer above `widget.json` comes from here. */
let userConfig = {};

/** Cancels the running pollers. Held so a config change can restart them at a new rate. */
let stopProviders = null;

/**
 * `~/.hikari/config.json`, or an empty config.
 *
 * A missing file is the normal case. Broken JSON is not, and it is reported rather than
 * swallowed: silently ignoring it means every setting the user just wrote appears to have
 * had no effect, with nothing on screen to say why.
 */
function readUserConfig() {
  if (!fs.existsSync(USER_CONFIG)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(USER_CONFIG, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    console.error(`[hikari] ${USER_CONFIG} is not valid JSON, ignoring it: ${e.message}`);
    return {};
  }
}

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
        const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        // The id comes from the file and the folder, never from the override -- otherwise
        // setting `name` in the user config would rename the widget out from under the very
        // key the override is filed at, and the override would stop applying to itself.
        const id = onDisk.name ?? name;
        const manifest = widgetConfig(onDisk, userConfig, id);
        // Checked after the merge, so `"enabled": false` in the user config turns a bundled
        // widget off without editing a tracked file, and `true` turns one back on.
        if (manifest.enabled === false) continue;
        found.push({ id, dir, onDisk, manifest });
      } catch (e) {
        // A widget with broken JSON is skipped loudly. Silently dropping it is how you
        // spend ten minutes wondering why one widget never appears.
        console.error(`[hikari] ${name}/widget.json is not valid JSON: ${e.message}`);
      }
    }
  }
  return found;
}

function createWidget({ id, dir, onDisk, manifest }) {
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
  // From the file on disk, never from the merged manifest. A user config line must not be
  // able to grant a capability, because a widget that can write that file would then be
  // able to grant itself one.
  capabilities.set(win.webContents.id, capabilitiesFrom(onDisk));

  // The theme is applied by the preload, not from here. See `hikari:theme` below and the
  // comment on it in preload.js: injecting from this side happens after the page's own
  // scripts have already read their tokens.
  win.loadFile(path.join(dir, "index.html"));
  // An overlay must not be on screen until it is summoned, so `startHidden` widgets are
  // built and loaded like any other and simply never shown. Loading them up front is what
  // makes the hotkey feel instant.
  win.once("ready-to-show", () => {
    if (!manifest.startHidden) win.show();
  });
  windows.set(id, win);
  registry.set(id, { id, dir, onDisk, win });
  return win;
}

/**
 * Re-read the settings and make the running app match them.
 *
 * This reconciles rather than only re-places, because the set of widgets is itself a
 * setting: `"enabled": false` has to close a window that is already open, and turning one
 * back on has to create it. Re-placing alone would leave a widget the user just switched
 * off sitting on screen, which reads as the setting not working.
 *
 * `discover()` runs again as part of it, so an edit to a `widget.json` is picked up too.
 *
 * Every widget reads `config()` once at module scope, which is fine for a value that never
 * changes and useless for one that does. So the host also pushes the new settings, and
 * re-places the window itself: a widget cannot move its own.
 */
function applyConfig() {
  const before = JSON.stringify(userConfig.providers ?? {});
  userConfig = readUserConfig();
  // Only when a provider setting actually changed. Restarting the pollers costs the CPU
  // provider its previous sample, so it reports unknown for one tick, and doing that every
  // time somebody nudges a widget's position would be a flicker for no reason.
  if (JSON.stringify(userConfig.providers ?? {}) !== before) {
    stopProviders?.();
    stopProviders = startProviders();
  }

  const found = new Map(discover().map((w) => [w.id, w]));
  const display = screen.getPrimaryDisplay();

  // Newly enabled widgets are created before disabled ones are closed, so the window count
  // never passes through zero. `window-all-closed` quits the app, and it fires the moment
  // the last window goes: swapping one widget for another would otherwise shut hikari down
  // halfway through applying a setting.
  const opened = [];
  const closed = [];
  for (const [id, w] of found) {
    if (!registry.has(id)) {
      createWidget(w);
      opened.push(id);
    }
  }

  for (const [id, entry] of [...registry]) {
    if (entry.win.isDestroyed()) {
      registry.delete(id);
      windows.delete(id);
      continue;
    }
    const next = found.get(id);
    if (!next) {
      // Switched off, or its folder went away. Every widget being switched off does quit
      // the app, which is the honest outcome: there is nothing left for it to show.
      registry.delete(id);
      windows.delete(id);
      entry.win.destroy();
      closed.push(id);
      continue;
    }
    entry.onDisk = next.onDisk;
    manifests.set(entry.win.webContents.id, next.manifest);
    entry.win.setBounds(place(display, next.manifest));
    entry.win.webContents.send("hikari:configChanged", next.manifest);
  }

  // Opening and closing a window is the one part of this a person can see happening, so it
  // is said out loud. Silence here is how "my setting did nothing" and "my setting worked
  // and I misread the screen" become the same experience.
  if (opened.length) console.log(`[hikari] opened: ${opened.join(", ")}`);
  if (closed.length) console.log(`[hikari] closed: ${closed.join(", ")}`);

  // `hotkey` is a setting like any other, and rebinding is all-or-nothing: unregisterAll
  // then register what survived, so a key belonging to a widget that was just switched off
  // is handed back rather than firing at a window that no longer exists.
  applyHotkeys([...found.values()]);
}

/**
 * Show or hide one widget, and tell it which happened.
 *
 * The `hikari:shown` message is what makes an overlay useful rather than a window that
 * appears. A widget reads the clipboard once at load, which is the wrong moment: the whole
 * interaction is copy something, then press the key. This is the widget's cue to look again
 * and to put the caret back in its input.
 */
function toggle(id) {
  const win = windows.get(id);
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
    return;
  }
  win.show();
  // focus() does nothing on a window built with focusable:false, which is every widget that
  // did not set `interactive`, so an overlay you can type into has to say so.
  if (manifests.get(win.webContents.id)?.interactive) win.focus();
  win.webContents.send("hikari:shown");
}

/**
 * Bind every widget's `hotkey`, and say out loud why each unbound one is unbound.
 *
 * There are two ways to end up with a key that does nothing, and neither announces itself:
 * a typo in the accelerator, which `plan()` catches before Electron sees it, and the
 * accelerator already belonging to another application, which `register` reports by
 * returning false. Ignoring that return is the classic bug in this feature: nothing
 * happens, nothing is logged, and the evening goes on the wrong thing.
 */
/**
 * Do what a shortcut says.
 *
 * A verb and a name, resolved here. Nothing that reaches this function came from a
 * renderer: it came from a `widget.json` or from `~/.hikari/config.json`, both of which the
 * user owns, and `launch` still goes through the dock's own lookup rather than round the
 * side of it.
 */
async function perform(binding) {
  const { verb, target } = binding;
  if (verb === "toggle") return toggle(target);

  if (verb === "reload") {
    const entry = registry.get(target);
    if (entry && !entry.win.isDestroyed()) entry.win.reload();
    return;
  }

  if (verb === "refresh") {
    // Restarting the pollers reads every provider immediately, which is what somebody
    // pressing this wants: the numbers now, not on the next tick.
    stopProviders?.();
    stopProviders = startProviders();
    console.log("[hikari] refreshed every provider");
    return;
  }

  if (verb === "hideAll") {
    let hidden = 0;
    for (const win of windows.values()) {
      if (!win.isDestroyed() && win.isVisible()) {
        win.hide();
        hidden++;
      }
    }
    console.log(`[hikari] hid ${hidden} widget(s)`);
    return;
  }

  if (verb === "launch") {
    // Through the same resolve the dock uses, so a shortcut cannot reach anything a dock
    // button could not. One lookup, one allowlist, one place to be wrong.
    const { entries } = readEntries(userConfig.dock);
    const resolved = resolveTarget(entries, target);
    if (resolved.error) {
      console.error(`[hikari] shortcut refused: ${resolved.error}`);
      return;
    }
    try {
      if (resolved.kind === "path") {
        const failure = await shell.openPath(resolved.value);
        if (failure) console.error(`[hikari] could not open ${resolved.label}: ${failure}`);
      } else {
        await shell.openExternal(resolved.value);
      }
      console.log(`[hikari] launched "${resolved.label}"`);
    } catch (e) {
      console.error(`[hikari] could not launch ${resolved.label}: ${e.message}`);
    }
    return;
  }

  // Unreachable while the action list and this switch agree, and said out loud rather than
  // ignored because the way they stop agreeing is somebody adding a verb to one of them.
  console.error(`[hikari] no handler for the "${verb}" action`);
}

/**
 * Bind every global shortcut: the ones widgets ask for and the ones you defined.
 *
 * Merged before anything is registered, so a widget hotkey and a shortcut competing for one
 * accelerator is caught here rather than by whichever happened to register first. That is
 * the failure worth catching, because the loser is silent: the key works, and does the
 * other thing.
 *
 * A global shortcut that quietly does nothing is the whole failure mode of this feature, so
 * every reason one is unbound is printed. There are four now, and none announces itself:
 * a malformed accelerator, two things wanting one key, a name that does not exist, and the
 * accelerator already belonging to another application.
 */
function applyHotkeys(widgets) {
  globalShortcut.unregisterAll();

  const fromWidgets = plan(widgets);
  for (const p of fromWidgets.problems) {
    console.error(`[hikari] ${p.id}: hotkey ${JSON.stringify(p.accelerator)} not bound, ${p.reason}`);
  }

  const { entries: dockEntries } = readEntries(userConfig.dock);
  const fromConfig = readShortcuts(
    userConfig.shortcuts,
    widgets.map((w) => w.id),
    dockEntries.map((e) => e.id),
  );
  for (const p of fromConfig.problems) console.error(`[hikari] ${p}`);

  const { bindings, problems } = mergeShortcuts(fromWidgets.bindings, fromConfig.bindings);
  for (const p of problems) console.error(`[hikari] ${p}`);

  for (const b of bindings) {
    const what = b.verb === "toggle" && b.from === "widget" ? b.target : `${b.verb}${b.target ? `:${b.target}` : ""}`;
    let won = false;
    try {
      won = globalShortcut.register(b.accelerator, () => {
        // Errors inside a shortcut callback have nowhere to go, so they are caught here
        // rather than becoming an unhandled rejection nobody sees.
        Promise.resolve(perform(b)).catch((e) => console.error(`[hikari] ${what} failed: ${e.message}`));
      });
    } catch (e) {
      // The accelerator passed our parser and Electron still refused it, which means the
      // two disagree. Worth the noise: it is a bug here, not in the user's config.
      console.error(`[hikari] Electron rejected "${b.accelerator}": ${e.message}`);
      continue;
    }
    if (won) console.log(`[hikari] ${b.accelerator} -> ${what}`);
    else console.error(`[hikari] "${b.accelerator}" is already taken by another application, so ${what} does nothing`);
  }
}

/**
 * Which widget a message came from, by its own id.
 *
 * From the registry rather than from the merged manifest, for the same reason the
 * capabilities are: a user config can set `name`, and a renamed state file loses the list
 * it was holding.
 */
function registryIdFor(webContentsId) {
  for (const entry of registry.values()) {
    if (!entry.win.isDestroyed() && entry.win.webContents.id === webContentsId) return entry.id;
  }
  return null;
}

function broadcast() {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send("hikari:state", state);
  }
}

/**
 * Poll every provider, and return a function that stops them all.
 *
 * Cancellable because a provider's interval is a setting now. Changing it has to mean
 * "stop the old timer and start a new one"; without a handle on the timers, a config edit
 * would leave the old one running and the machine would poll at both rates forever.
 */
function startProviders() {
  const timers = [];
  for (const p of providers) {
    const config = providerConfig(p, userConfig);
    const intervalMs = providerInterval(p, config);
    if (config.intervalMs !== undefined && intervalMs !== Number(config.intervalMs)) {
      console.error(
        `[hikari] provider "${p.name}": intervalMs ${config.intervalMs} is below the ${MIN_INTERVAL_MS}ms floor, using ${intervalMs}ms`,
      );
    }
    const tick = async () => {
      try {
        // Config is passed on every read rather than captured, so a provider never holds a
        // stale copy of a setting the user has since changed.
        state[p.name] = await p.read(providerConfig(p, userConfig));
        broadcast();
      } catch (e) {
        console.error(`[hikari] provider "${p.name}" failed: ${e.message}`);
      }
    };
    tick();
    const t = setInterval(tick, intervalMs);
    t.unref?.();
    timers.push(t);
  }
  return () => {
    for (const t of timers) clearInterval(t);
  };
}

/**
 * One save fires several `fs.watch` events, and each one would re-place every window.
 *
 * Keyed so a burst on one widget collapses into one reload without delaying another's.
 */
const DEBOUNCE_MS = 120;
const pending = new Map();
function debounced(key, fn) {
  clearTimeout(pending.get(key));
  const t = setTimeout(() => {
    pending.delete(key);
    fn();
  }, DEBOUNCE_MS);
  t.unref?.();
  pending.set(key, t);
}

/**
 * `fs.watch`, with the two reasons it fails treated as non-fatal.
 *
 * The *directory* is watched, never the file. Editors save by writing a temporary file and
 * renaming it over the target, which replaces the inode, so an `fs.watch` on the file keeps
 * watching the old one and never fires again after the first save. Watching the directory
 * also means the first ever save, of a file that did not exist at startup, is seen.
 */
function watch(dir, onChange, { recursive = false } = {}) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.watch(dir, { recursive }, (_event, filename) => onChange(filename)).unref?.();
  } catch (e) {
    // Recursive watching is not available everywhere. Losing it means edits need a restart,
    // which is worth saying rather than leaving the user to notice nothing happening.
    console.error(`[hikari] cannot watch ${dir}, changes there need a restart: ${e.message}`);
  }
}

/** Reload settings when the user saves them, and widgets when their files change. */
function watchEverything() {
  watch(HIKARI_HOME, (filename) => {
    if (filename && path.basename(filename) !== "config.json") return;
    debounced("config", () => {
      console.log("[hikari] config.json changed, reapplying");
      applyConfig();
    });
  });

  for (const root of WIDGET_DIRS) {
    watch(
      root,
      (filename) => {
        const hit = changed(filename);
        if (!hit) return;
        // A manifest edit changes where the window goes, whether it exists at all and what
        // it may do, so it goes through the same reconcile a settings change does.
        if (hit.manifest) {
          debounced("config", () => {
            console.log(`[hikari] ${hit.folder}/widget.json changed, reapplying`);
            applyConfig();
          });
          return;
        }
        // Anything else is the page. Reload that one window and leave the rest alone.
        const entry = [...registry.values()].find((e) => path.basename(e.dir) === hit.folder);
        if (!entry || entry.win.isDestroyed()) return;
        debounced(`widget:${hit.folder}`, () => {
          if (entry.win.isDestroyed()) return;
          console.log(`[hikari] ${hit.folder} changed, reloading it`);
          entry.win.reload();
        });
      },
      { recursive: true },
    );
  }
}

app.whenReady().then(() => {
  /**
   * The theme, as stylesheet text, in the order it must be applied.
   *
   * Synchronous because the preload asks for it before the page exists, and read from disk
   * on every ask so a saved edit to `~/.hikari/theme.css` lands on the next reload rather
   * than on the next launch.
   *
   * Every widget also carries `<link href="../theme.css">`, which is what themes it in the
   * browser preview where there is no preload at all. That link resolves against the
   * widget's own folder, so for a widget in `~/.hikari/widgets/foo/` it points at a file
   * that does not exist, and that is the whole reason the host injects instead of trusting
   * it. Bundled widgets end up with the base sheet twice, which changes nothing.
   */
  ipcMain.on("hikari:theme", (e) => {
    e.returnValue = themeSources(BASE_THEME, USER_THEME, fs.existsSync).map((css) => {
      try {
        return fs.readFileSync(css, "utf8");
      } catch (err) {
        // An unthemed widget looks broken rather than unstyled, and the cause is not
        // guessable from the screen, so it is worth saying out loud.
        console.error(`[hikari] could not read ${path.basename(css)}: ${err.message}`);
        return "";
      }
    });
  });

  /**
   * A widget's own state, read and written by the host.
   *
   * **A widget never names a file.** There is no path parameter, and there is deliberately
   * no way to add one: the host resolves the *asking* widget's id to one file under
   * `~/.hikari/state/`. So there is nothing to traverse out of, and one widget cannot reach
   * another's data because it cannot express another's name. `src/lib/store.js` is the
   * check on that id and it is mostly refusals.
   *
   * Gated on `"storage": true` in the manifest, like the clipboard, and checked the same
   * way: against the manifest of the window the message came from.
   */
  ipcMain.handle("hikari:store:get", (e) => {
    const caps = capabilities.get(e.sender.id);
    if (!granted(caps, "storage")) {
      const msg = 'this widget did not ask to store anything. Add "storage": true to its widget.json.';
      console.error(`[hikari] refused a state read: ${msg}`);
      throw new Error(msg);
    }
    const where = statePath(HIKARI_HOME, registryIdFor(e.sender.id));
    if (where.error) throw new Error(where.error);
    if (!fs.existsSync(where.path)) return null;
    try {
      return readState(fs.readFileSync(where.path, "utf8"));
    } catch (err) {
      // Unreadable is not the same as empty, and a widget that cannot tell them apart would
      // helpfully overwrite a file it failed to read.
      throw new Error(`could not read ${path.basename(where.path)}: ${err.message}`);
    }
  });

  ipcMain.handle("hikari:store:set", (e, value) => {
    const caps = capabilities.get(e.sender.id);
    if (!granted(caps, "storage")) {
      const msg = 'this widget did not ask to store anything. Add "storage": true to its widget.json.';
      console.error(`[hikari] refused a state write: ${msg}`);
      throw new Error(msg);
    }
    const where = statePath(HIKARI_HOME, registryIdFor(e.sender.id));
    if (where.error) throw new Error(where.error);

    const ready = writable(value);
    if (ready.error) throw new Error(ready.error);

    fs.mkdirSync(where.dir, { recursive: true });

    /**
     * Written to a temporary file and renamed over the target.
     *
     * `rename` within one directory is atomic, so a reader sees either the whole old file or
     * the whole new one. Writing in place is not: a crash or a full disk halfway through
     * leaves a truncated file, which parses as invalid JSON and reads as an empty list. That
     * is the one failure this widget must not have, because the thing it would silently
     * discard is the only copy.
     *
     * The temporary name carries the process id so two hosts cannot collide on it.
     */
    const tmp = `${where.path}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, ready.text, "utf8");
      fs.renameSync(tmp, where.path);
    } catch (err) {
      // Cleaned up, or the state directory fills with orphaned temporary files that nobody
      // will ever look at.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Nothing useful to do about a failed cleanup, and throwing here would replace the
        // real error with a worse one.
      }
      throw new Error(`could not write ${path.basename(where.path)}: ${err.message}`);
    }
    return true;
  });

  /**
   * The dock's entries, so a widget can draw buttons for what the user configured.
   *
   * Read only, and it carries no paths: a widget is told the id and the label and nothing
   * else. Handing it the path would let it display one thing and would still not let it run
   * another, but there is no reason for it to know, and the icon comes through a separate
   * call that resolves the id itself.
   */
  ipcMain.handle("hikari:dock", (e) => {
    const caps = capabilities.get(e.sender.id);
    if (!granted(caps, "launch")) {
      const msg = 'this widget did not ask to launch anything. Add "launch": true to its widget.json.';
      console.error(`[hikari] refused a dock read: ${msg}`);
      throw new Error(msg);
    }
    const { entries, problems } = readEntries(userConfig.dock);
    for (const p of problems) console.error(`[hikari] dock: ${p}`);
    // Ids and labels only.
    return { entries: entries.map(({ id, label, kind }) => ({ id, label, kind })), problems };
  });

  /**
   * Start one of the user's own dock entries.
   *
   * **The renderer names an id, never a target.** There is no path parameter, no URI
   * parameter, no argument list and no command string, so there is nothing to inject into.
   * The id is looked up by strict comparison against an array, never as a property of an
   * object, because a lookup would answer `"__proto__"` with something inherited and that
   * value would then reach a shell call.
   *
   * `shell.openPath` and `shell.openExternal` both take a value rather than a command line,
   * and there is no `child_process` anywhere in this path. Quoting and metacharacters are
   * therefore not handled carefully here: they are not a category of bug, which is a
   * stronger position than handling them.
   */
  ipcMain.handle("hikari:launch", async (e, id) => {
    const caps = capabilities.get(e.sender.id);
    if (!granted(caps, "launch")) {
      const msg = 'this widget did not ask to launch anything. Add "launch": true to its widget.json.';
      console.error(`[hikari] refused a launch: ${msg}`);
      throw new Error(msg);
    }

    const { entries } = readEntries(userConfig.dock);
    const target = resolveTarget(entries, id);
    if (target.error) {
      // Loudly, never as a no-op. A dock button that silently does nothing is
      // indistinguishable from a broken app, and the config is what nobody thinks to check.
      console.error(`[hikari] refused a launch: ${target.error}`);
      throw new Error(target.error);
    }

    console.log(`[hikari] launching "${target.label}"`);
    if (target.kind === "path") {
      // Returns a string, empty on success, rather than throwing. Ignoring it means a
      // missing application looks exactly like a working one.
      const failure = await shell.openPath(target.value);
      if (failure) throw new Error(`could not open ${target.label}: ${failure}`);
      return true;
    }
    await shell.openExternal(target.value);
    return true;
  });

  /**
   * The real icon of an installed application, as a data URL.
   *
   * Nothing is bundled and nothing is drawn. `app.getFileIcon` asks the OS for the icon it
   * already shows for that file, so the dock shows your own applications looking like
   * themselves, with nothing to license and nothing to ship.
   *
   * Resolved from the id here rather than taking a path, for the same reason `launch` does:
   * a renderer that could name a file could read an icon out of anywhere on the disk, which
   * is a small leak and an unnecessary one.
   *
   * `path.normalize` is not tidiness. On Windows a forward-slash path returns the generic
   * document icon rather than the one embedded in the executable, which looks exactly like
   * the API failing when it is the path that is wrong.
   *
   * **No `size` option, and that is load-bearing.** `{ size: "large" }` is the obvious thing
   * to ask for and it hard-crashes Electron 33.4.11 on macOS: `FATAL check.cc Check failed:
   * false. NOTREACHED`, the whole process, on the first call. Not an exception, so no
   * try/catch can save it, and the dock would have taken the app down every time it drew.
   * Measured by calling it three ways in isolation: no option and `{ size: "normal" }` both
   * return a 32x32 image, `{ size: "large" }` crashes.
   *
   * 32x32 is more than the 26px the dock draws, so nothing is lost. If somebody adds the
   * option back for a bigger icon, they will find this comment in the crash report.
   */
  ipcMain.handle("hikari:dock-icon", async (e, id) => {
    const caps = capabilities.get(e.sender.id);
    if (!granted(caps, "launch")) {
      throw new Error('this widget did not ask to launch anything. Add "launch": true to its widget.json.');
    }
    const { entries } = readEntries(userConfig.dock);
    const target = resolveTarget(entries, id);
    if (target.error) throw new Error(target.error);
    // A URI has no file to take an icon from. Null rather than an error, because the widget
    // draws a letter instead and that is a normal outcome rather than a failure.
    if (target.kind !== "path") return null;
    try {
      const image = await app.getFileIcon(path.normalize(target.value));
      // An empty image is what a missing file gives, and it renders as a blank square that
      // looks like a broken widget rather than a missing application.
      if (!image || image.isEmpty()) return null;
      return image.toDataURL();
    } catch (err) {
      console.error(`[hikari] no icon for "${target.label}": ${err.message}`);
      return null;
    }
  });

  ipcMain.handle("hikari:media", (_e, action) => control(action));
  ipcMain.handle("hikari:state", () => state);
  ipcMain.handle("hikari:config", (e) => manifests.get(e.sender.id) ?? {});

  /**
   * The clipboard, only for a widget that asked for it.
   *
   * The check is against the manifest of the window that sent the message, looked up by
   * its `webContents` id, so it is the *asking* widget's own manifest and no widget can
   * claim to be another. A refusal throws, which reaches the widget as a rejected promise
   * and is logged here too: a permission that fails by returning an empty string is
   * indistinguishable from an empty clipboard, and the widget would show "nothing copied".
   */
  ipcMain.handle("hikari:clipboard", (e) => {
    const caps = capabilities.get(e.sender.id);
    if (!granted(caps, "clipboard")) {
      const msg = 'this widget did not ask for the clipboard. Add "clipboard": true to its widget.json.';
      console.error(`[hikari] refused clipboard read: ${msg}`);
      throw new Error(msg);
    }
    return clipboard.readText();
  });

  // Before discover(), because the user config decides which widgets exist.
  userConfig = readUserConfig();

  const widgets = discover();
  if (widgets.length === 0) {
    console.error(`[hikari] no widgets found. Looked in:\n  ${WIDGET_DIRS.join("\n  ")}`);
    app.quit();
    return;
  }
  for (const w of widgets) createWidget(w);
  console.log(`[hikari] ${widgets.length} widget(s): ${widgets.map((w) => w.id).join(", ")}`);
  applyHotkeys(widgets);
  stopProviders = startProviders();
  watchEverything();
});

// Global shortcuts outlive the windows they belong to, so they have to be handed back or
// the accelerator stays claimed until the process is gone.
app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("window-all-closed", () => app.quit());

module.exports = { place, discover };
