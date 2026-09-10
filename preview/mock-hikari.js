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
      date: {
        time: d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        seconds: d.getSeconds(),
        day: d.toLocaleDateString([], { weekday: "short" }),
        date: d.toLocaleDateString([], { day: "numeric", month: "short" }),
      },
    };
  }

  /** A state named in the query string, or null to cycle. */
  const pinnedWeather = (() => {
    const want = new URLSearchParams(location.search).get("weather");
    const i = ["fresh", "stale", "unknown"].indexOf(want);
    return i === -1 ? null : i;
  })();

  /** The same, for the calendar. `?calendar=clear` is a week with nothing in it, which is
   *  not `?calendar=empty`, a feed with nothing in it. */
  const pinnedCalendar = (() => {
    const want = new URLSearchParams(location.search).get("calendar");
    const i = ["fresh", "stale", "empty", "clear", "unavailable"].indexOf(want);
    return i === -1 ? null : i;
  })();

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
