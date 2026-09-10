/**
 * The only surface a widget gets. Context-isolated, so a widget cannot reach Node.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hikari", {
  /** Called with the merged provider state on every tick. Returns an unsubscribe. */
  subscribe(fn) {
    const handler = (_e, state) => fn(state);
    ipcRenderer.on("hikari:state", handler);
    ipcRenderer.invoke("hikari:state").then(fn);
    return () => ipcRenderer.off("hikari:state", handler);
  },
  /** This widget's own entry from its widget.json. */
  config: () => ipcRenderer.invoke("hikari:config"),
  media: {
    playPause: () => ipcRenderer.invoke("hikari:media", "playpause"),
    next: () => ipcRenderer.invoke("hikari:media", "next"),
    previous: () => ipcRenderer.invoke("hikari:media", "previous"),
  },
});
