/**
 * The only surface a widget gets. Context-isolated, so a widget cannot reach Node.
 */
const { contextBridge, ipcRenderer, webFrame } = require("electron");

/**
 * The theme, applied before the page runs.
 *
 * This has to happen here rather than from the main process, and the reason is a timing bug
 * that cost a whole verification run to find. `webContents.insertCSS` on `did-finish-load`
 * applies the stylesheet *after* the page's own scripts have run, and a widget reads its
 * theme tokens at startup: the shader reads `--accent` once to build its uniforms, so it
 * would silently fall back to its hardcoded purple and teal with a themed page underneath
 * it. A preload runs before any page script, and `webFrame.insertCSS` applies immediately,
 * so a token is readable by the first line of the widget.
 *
 * `sendSync` is the right tool exactly once, and this is it: the value is needed before the
 * page exists, so there is nothing to await in.
 */
for (const css of ipcRenderer.sendSync("hikari:theme")) webFrame.insertCSS(css);

contextBridge.exposeInMainWorld("hikari", {
  /** Called with the merged provider state on every tick. Returns an unsubscribe. */
  subscribe(fn) {
    const handler = (_e, state) => fn(state);
    ipcRenderer.on("hikari:state", handler);
    ipcRenderer.invoke("hikari:state").then(fn);
    return () => ipcRenderer.off("hikari:state", handler);
  },
  /** This widget's settings: its widget.json with the user's overrides applied. */
  config: () => ipcRenderer.invoke("hikari:config"),
  /**
   * Called with the new settings whenever they change. Returns an unsubscribe.
   *
   * A widget that ignores this still works, it just needs a restart to pick a change up.
   * The host re-places the window itself either way, since a widget cannot move its own.
   */
  onConfigChange(fn) {
    const handler = (_e, config) => fn(config);
    ipcRenderer.on("hikari:configChanged", handler);
    return () => ipcRenderer.off("hikari:configChanged", handler);
  },
  /**
   * Called when the host shows this widget, which for an overlay is the interesting moment.
   * Returns an unsubscribe.
   *
   * A widget that reads the clipboard at load reads it at the wrong time: the interaction
   * is copy something, then press the key. This is the cue to look again.
   */
  onShown(fn) {
    const handler = () => fn();
    ipcRenderer.on("hikari:shown", handler);
    return () => ipcRenderer.off("hikari:shown", handler);
  },
  /**
   * Reads the clipboard, and rejects for a widget whose `widget.json` did not ask for it.
   *
   * The method is on the bridge for every widget because the preload has no way to know
   * which widget it is preloading. The permission is checked in the main process against
   * the manifest of the window the message came from, which is the one place a renderer
   * cannot reach. Exposing it here and refusing there is the whole shape of it: one
   * enforcement point, in the trusted process.
   *
   * Read only. Nothing needs to write, so there is nothing to write with.
   */
  clipboard: {
    readText: () => ipcRenderer.invoke("hikari:clipboard"),
  },
  /**
   * This widget's own stored state. Rejects for a widget that did not ask for it.
   *
   * Notice what is missing: there is no filename, and no way to supply one. The host
   * resolves this widget's own id to one file under `~/.hikari/state/`, so a widget cannot
   * write anywhere else and cannot read another widget's data, because it cannot express
   * another widget's name.
   *
   * `set` replaces the whole value rather than merging. A merge would need the host to
   * understand the shape, and the host understanding a widget's data is how a widget host
   * turns into a framework.
   */
  store: {
    get: () => ipcRenderer.invoke("hikari:store:get"),
    set: (value) => ipcRenderer.invoke("hikari:store:set", value),
  },
  /**
   * The dock: what the user configured, and a way to start one of them.
   *
   * `launch` takes an id and nothing else. There is no path parameter and no way to add
   * one, so a widget can ask for the entry the user called "steam" and cannot ask for
   * anything the user did not write down. The host resolves the id against its own copy of
   * the config, which the renderer never sees the targets of.
   */
  dock: {
    entries: () => ipcRenderer.invoke("hikari:dock"),
    launch: (id) => ipcRenderer.invoke("hikari:launch", id),
    icon: (id) => ipcRenderer.invoke("hikari:dock-icon", id),
  },
  media: {
    playPause: () => ipcRenderer.invoke("hikari:media", "playpause"),
    next: () => ipcRenderer.invoke("hikari:media", "next"),
    previous: () => ipcRenderer.invoke("hikari:media", "previous"),
  },
});
