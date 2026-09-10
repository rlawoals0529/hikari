/**
 * Stands in for the preload bridge so a widget opens in any browser.
 *
 * The widget cannot tell the difference: it sees the same `window.hikari` shape it gets
 * from the host. That is what lets the visual half be built without Electron running.
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
    media: {
      playPause: () => (console.log("[preview] play/pause"), Promise.resolve(true)),
      next: () => (console.log("[preview] next"), Promise.resolve(true)),
      previous: () => (console.log("[preview] previous"), Promise.resolve(true)),
    },
  };
})();
