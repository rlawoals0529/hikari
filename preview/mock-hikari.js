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

  /**
   * Fresh, stale and unknown. A preview that only ever shows the happy state is not one,
   * and for this widget the interesting half is what it does when it does not know.
   *
   * `?weather=stale` pins one, because otherwise every frame on the preview page runs its
   * own mock from tick one and they all show the same state.
   */
  const WEATHER = [
    { available: true, freshness: "fresh", takenAt: Date.now(), temperature: 18.7,
      feelsLike: 16.4, humidity: 59, windSpeed: 16.9, isDay: true, code: 3,
      condition: "overcast", high: 20.3, low: 14, units: "metric", timezone: "Europe/London" },
    { available: true, freshness: "stale", takenAt: Date.now() - 95 * 60 * 1000,
      temperature: 2.1, feelsLike: -3.4, humidity: 81, windSpeed: 34, isDay: false, code: 73,
      condition: "snow", high: 3, low: -2, units: "metric", timezone: "America/Toronto" },
    { available: false, freshness: "expired",
      reason: 'set "latitude" and "longitude", or "place", under providers.weather in ~/.hikari/config.json' },
  ];

  /**
   * The calendar, in every state the widget has to render.
   *
   * Times are built from load rather than written down, because the widget's day headings
   * are relative -- "today", "tomorrow" -- and a fixture dated last March would render as a
   * wall of dates and quietly stop exercising the interesting branch.
   *
   * The two empty states are both here on purpose. An empty feed and a clear week produce
   * the same empty list and mean opposite things, so a preview that only carried one of
   * them would let the wrong sentence ship.
   */
  const CALENDAR = (() => {
    const now = Date.now();
    const hours = (n) => now + n * 3600000;
    /** Local midnight n days out, which is where an all-day event starts. */
    const midnight = (n) => {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + n);
      return d.getTime();
    };
    const events = [
      { uid: "1", summary: "Platform standup", location: "Room 3",
        start: hours(-0.3), end: hours(0.7), allDay: false },
      { uid: "2", summary: "Design review, new onboarding flow", location: null,
        start: hours(3), end: hours(4), allDay: false },
      { uid: "3", summary: "Company holiday", location: null,
        start: midnight(1), end: midnight(2), allDay: true },
      { uid: "4", summary: "One to one", location: "Cafe; corner table",
        start: midnight(2) + 10 * 3600000, end: midnight(2) + 10.5 * 3600000, allDay: false },
      { uid: "5", summary: "Quarterly planning review with the whole of platform engineering",
        location: null, start: midnight(3) + 14 * 3600000, end: midnight(3) + 16 * 3600000,
        allDay: false },
    ];
    return [
      { available: true, freshness: "fresh", takenAt: now, source: "url:https://example.com/work.ics",
        events, total: events.length, days: 7 },
      { available: true, freshness: "stale", takenAt: now - 5 * 3600000,
        source: "url:https://example.com/work.ics", events: events.slice(2), total: 9, days: 7 },
      { available: true, freshness: "fresh", takenAt: now, source: "file:/home/me/work.ics",
        events: [], total: 0, days: 7 },
      { available: true, freshness: "fresh", takenAt: now, source: "url:https://example.com/work.ics",
        events: [], total: 12, days: 7 },
      { available: false, freshness: "expired",
        reason: 'set "url" or "file" under providers.calendar in ~/.hikari/config.json' },
    ];
  })();

  /**
   * The battery, in every state the widget has to tell apart.
   *
   * `none` is the one that earns its place. A desktop has no battery, and the reading a
   * naive provider gives one is 0%: a full red bar on a machine that cannot lose power. It
   * has to be visibly a different thing from a flat battery, and a preview that never showed
   * it would let the wrong render ship.
   */
  const BATTERY = [
    { available: true, freshness: "fresh", takenAt: Date.now(), installed: true, percent: 66,
      state: "discharging", charging: false, plugged: false, minutesRemaining: 355 },
    { available: true, freshness: "fresh", takenAt: Date.now(), installed: true, percent: 41,
      state: "charging", charging: true, plugged: true, minutesRemaining: 74 },
    { available: true, freshness: "fresh", takenAt: Date.now(), installed: true, percent: 100,
      state: "charged", charging: false, plugged: true, minutesRemaining: null },
    // Low, on the pack, with no estimate yet. Two unknowns at once, which is what the first
    // minute after unplugging actually looks like.
    { available: true, freshness: "fresh", takenAt: Date.now(), installed: true, percent: 8,
      state: "discharging", charging: false, plugged: false, minutesRemaining: null },
    { available: true, freshness: "fresh", takenAt: Date.now(), installed: false, percent: null,
      state: null, charging: null, plugged: true, minutesRemaining: null },
    { available: true, freshness: "stale", takenAt: Date.now() - 6 * 60 * 1000, installed: true,
      percent: 52, state: "discharging", charging: false, plugged: false, minutesRemaining: 190 },
    { available: false, freshness: "expired", reason: "pmset failed: spawn pmset ENOENT" },
  ];

  /**
   * The disks, including a path that is not there.
   *
   * The bad path is a row rather than a gap, because a mistyped path is the most likely
   * thing to be wrong about this provider and a widget showing one fewer line gives you
   * nothing to fix. The figures are the real ones off the machine this was built on.
   */
  const DISK = [
    { available: true, volumes: [
      { path: "/", label: "/", total: 994610155520, free: 178575511552, used: 816034643968, usage: 82.05 },
    ] },
    { available: true, volumes: [
      { path: "/", label: "/", total: 994610155520, free: 178575511552, used: 816034643968, usage: 82.05 },
      { path: "/Volumes/Archive", label: "Archive", total: 4000787030016, free: 61065490432, used: 3939721539584, usage: 98.47 },
    ] },
    { available: true, volumes: [
      { path: "/", label: "/", total: 994610155520, free: 178575511552, used: 816034643968, usage: 82.05 },
      { path: "/Volumes/Backup", label: "Backup", error: "no such path (ENOENT)" },
    ] },
    { available: false, reason: '"paths" under providers.disk contains 5, which is not a path', volumes: [] },
  ];

  /**
   * The network, up and down and unreadable.
   *
   * `rxPerSec` and `txPerSec` are null in every one of them, and that is not an omission in
   * the fixture: the provider reports throughput as unknown on every platform, for the
   * reasons at the top of src/lib/network.js. A mock that invented a rate would be the one
   * place in this repo where a made-up number was allowed.
   */
  const NETWORK = [
    { available: true, up: true, name: "en0", address: "192.168.12.67", family: "IPv4",
      interfaces: [{ name: "en0", address: "192.168.12.67", family: "IPv4", mac: "80:d1:ce:06:a7:c2" }],
      rxPerSec: null, txPerSec: null },
    { available: true, up: false, name: null, address: null, family: null, interfaces: [],
      rxPerSec: null, txPerSec: null },
    { available: false, up: null, reason: "the operating system listed no network interfaces" },
  ];

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
      // Cycles through the three states the weather widget has to render, because the
      // interesting half of that widget is what it does when it does not know.
      weather: WEATHER[pinnedWeather ?? Math.floor(tick / 10) % WEATHER.length],
      calendar: CALENDAR[pinnedCalendar ?? Math.floor(tick / 10) % CALENDAR.length],
      // The same cycling, for the same reason: each of these three has a state that only
      // shows up when something is absent, and that is the state worth building against.
      battery: BATTERY[pinnedBattery ?? Math.floor(tick / 8) % BATTERY.length],
      disk: DISK[pinnedDisk ?? Math.floor(tick / 10) % DISK.length],
      network: NETWORK[pinnedNetwork ?? Math.floor(tick / 10) % NETWORK.length],
      date: {
        time: d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        seconds: d.getSeconds(),
        day: d.toLocaleDateString([], { weekday: "short" }),
        date: d.toLocaleDateString([], { day: "numeric", month: "short" }),
      },
    };
  }

  /**
   * A state named in the query string, or null to cycle.
   *
   * One helper rather than one closure per provider. This was two copies of the same four
   * lines and the third provider to need it would have made it three, which is how the
   * per-widget config merge this file replaced got to four copies with four different bugs.
   */
  function pin(key, names) {
    const i = names.indexOf(new URLSearchParams(location.search).get(key));
    return i === -1 ? null : i;
  }

  const pinnedWeather = pin("weather", ["fresh", "stale", "unknown"]);

  /** `?calendar=clear` is a week with nothing in it, which is not `?calendar=empty`, a feed
   *  with nothing in it. */
  const pinnedCalendar = pin("calendar", ["fresh", "stale", "empty", "clear", "unavailable"]);

  /**
   * `?battery=none` is the desktop, which is not `?battery=low`.
   *
   * Named rather than numbered, because the whole point of these fixtures is that two of
   * them look alike on screen and mean opposite things, and an index would not say which.
   */
  const pinnedBattery = pin("battery", ["discharging", "charging", "charged", "low", "none", "stale", "unavailable"]);

  /** `?disk=missing` is one path that is not there beside one that is, which is not
   *  `?disk=unavailable`, a `paths` setting that cannot be read at all. */
  const pinnedDisk = pin("disk", ["one", "two", "missing", "unavailable"]);

  /** `?network=down` is a machine with no routable address. `?network=unavailable` is this
   *  provider failing, and the widget must not render the second as the first. */
  const pinnedNetwork = pin("network", ["up", "down", "unavailable"]);

  const subs = new Set();
  setInterval(() => { const s = snapshot(); subs.forEach((f) => f(s)); }, 1000);

  window.hikari = {
    subscribe(fn) { subs.add(fn); fn(snapshot()); return () => subs.delete(fn); },
    config: () => Promise.resolve(window.hikariConfig.fromQuery(location.search)),
    /**
     * State, kept in memory for the length of the page.
     *
     * Not `localStorage`, and that is deliberate. A widget built here would then behave
     * differently from one on the desktop in the one way that matters: whether it remembers
     * across a reload. In memory it forgets, and a preview that forgets is honest about
     * being a preview. `?state=...` seeds it, so a widget can be built against a list.
     */
    store: (() => {
      let value = (() => {
        const seed = window.hikariConfig.fromQuery(location.search).state;
        if (typeof seed !== "string") return null;
        try {
          return JSON.parse(seed);
        } catch {
          console.warn("[preview] ?state= is not valid JSON, starting empty");
          return null;
        }
      })();
      return {
        get: () => Promise.resolve(value),
        set: (next) => {
          value = next;
          return Promise.resolve(true);
        },
      };
    })(),
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
