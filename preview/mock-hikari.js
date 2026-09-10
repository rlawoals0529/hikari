/**
 * Stands in for the preload bridge so a widget opens in any browser.
 *
 * The widget cannot tell the difference: it sees the same `window.hikari` shape it gets
 * from the host. That is what lets the visual half be built without Electron running.
 *
 * `config()` reads the query string, which is why a widget needs no preview-only branch.
 * Every widget used to carry its own `URLSearchParams` merge beside its `config()` call,
 * four slightly different copies, and each had a coercion bug the others did not: one
 * treated every value as a string, one only looked at two keys, one ignored the query
 * entirely under the host and the manifest entirely under the preview. One place now.
 */
(function () {
  let cpu = 22, mem = 58, tick = 0;
  const TRACKS = [
    { title: "Blue Hour", artist: "Yorushika", isPlaying: true, available: true },
    { title: "Departure", artist: "Masayoshi Soeda", isPlaying: true, available: true },
    { title: null, artist: null, isPlaying: false, available: false },
  ];
  const jitter = (v, a, lo, hi) => Math.max(lo, Math.min(hi, v + (Math.random() - 0.5) * a));

  function snapshot() {
    tick++;
    cpu = jitter(cpu, 20, 3, 96);
    mem = jitter(mem, 4, 30, 90);
    const d = new Date();
    return {
      cpu: { usage: cpu },
      memory: { usage: mem },
      host: { hostname: "desktop", platform: "win32" },
      media: TRACKS[Math.floor(tick / 14) % TRACKS.length],
      date: {
        time: d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        seconds: d.getSeconds(),
        day: d.toLocaleDateString([], { weekday: "short" }),
        date: d.toLocaleDateString([], { day: "numeric", month: "short" }),
      },
    };
  }

  const subs = new Set();
  setInterval(() => { const s = snapshot(); subs.forEach((f) => f(s)); }, 1000);

  window.hikari = {
    subscribe(fn) { subs.add(fn); fn(snapshot()); return () => subs.delete(fn); },
    config: () => Promise.resolve(window.hikariConfig.fromQuery(location.search)),
    // Nothing changes settings in a browser, so this is a subscription that never fires.
    // It exists so a widget can call it without asking which host it is running in.
    onConfigChange: () => () => {},
    /**
     * In the preview the widget is on screen already, so this fires once and then never.
     * An overlay built here still gets its one cue rather than sitting empty.
     */
    onShown(fn) {
      const t = setTimeout(fn, 0);
      return () => clearTimeout(t);
    },
    /**
     * `?clipboardText=...` stands in for the clipboard, so an overlay can be built against
     * a known input with no permission prompt.
     *
     * This does NOT model the permission. The real check lives in the main process, against
     * the manifest of the window the message came from, and a browser has no trusted process
     * to put it in. Re-implementing the rule here would be a second copy of a security
     * decision that has to have exactly one.
     */
    clipboard: {
      readText: () => Promise.resolve(window.hikariConfig.fromQuery(location.search).clipboardText ?? ""),
    },
    media: {
      playPause: () => (console.log("[preview] play/pause"), Promise.resolve(true)),
      next: () => (console.log("[preview] next"), Promise.resolve(true)),
      previous: () => (console.log("[preview] previous"), Promise.resolve(true)),
    },
  };
})();
