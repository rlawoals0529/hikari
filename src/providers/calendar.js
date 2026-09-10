/**
 * The next few things in your calendar, from a feed that needs no key and no signup.
 *
 * Two ways in, both keyless, because the two ways people actually have a calendar are a
 * subscription URL from whatever hosts it and a file on disk:
 *
 *   { "providers": { "calendar": { "url": "https://...", "days": 7 } } }
 *   { "providers": { "calendar": { "file": "/path/to/work.ics" } } }
 *
 * The fetch happens here, in the main process, and that is the point: a widget fetching a
 * calendar feed from a page would be refused by CORS on nearly every host that serves one,
 * because a calendar service has no reason to allow it. The main process has no origin and
 * no such rule.
 *
 * This file does the fetch, the read and the caching and nothing else. Unfolding, parsing,
 * the three date forms, the window and the staleness rule are all in `src/lib/ics.js`,
 * where they are tested against a fixture with no network and no calendar.
 *
 * **A subscription URL is a credential.** Anyone holding it can read the calendar, so it
 * belongs in `~/.hikari/config.json`, which git has never heard of, and nowhere near this
 * repository. That is also why an http URL is refused outright rather than fetched: see
 * `readSource`.
 */
const fs = require("node:fs/promises");
const { readEvents, readSource, upcoming, windowDays, present } = require("../lib/ics");

/** Fifteen minutes. A calendar changes when a person changes it, which is not often, and
 *  polling somebody else's server faster than that spends their bandwidth to redraw the
 *  same three meetings. */
const INTERVAL_MS = 15 * 60 * 1000;

/** Enough to fail rather than hang. A widget that never resolves shows nothing forever. */
const TIMEOUT_MS = 8000;

/**
 * The last good read, kept across polls.
 *
 * The **whole** parsed event list is what is kept, not the window. The window is recomputed
 * on every read, so a cached feed still answers "what is next" correctly as the day moves
 * through it. Storing the window instead would leave a meeting that finished an hour ago at
 * the top of the widget until the next successful fetch.
 */
let last = null;
let lastError = null;

async function fetchText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "text/calendar, text/plain" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * The kept feed as the shape a widget reads, windowed at `now`.
 *
 * `total` is there so the widget can tell two different empty states apart: a feed with no
 * events in it at all, and a feed whose events are simply not in the next few days. They
 * read the same as an empty list and they mean opposite things -- one is a calendar to fix,
 * the other is a clear week.
 */
function view(now, days) {
  if (!last) return null;
  return {
    takenAt: last.takenAt,
    source: last.source,
    events: upcoming(last.events, now, days),
    total: last.events.length,
    days: windowDays(days),
  };
}

const calendar = {
  name: "calendar",
  intervalMs: INTERVAL_MS,
  /**
   * No default feed, deliberately, and the same reason weather has no default location: a
   * default would put somebody else's appointments on your desktop and look like it had
   * worked. `days` is the one thing with a sensible default, because a week is a week.
   */
  defaults: { days: 7 },
  async read(config) {
    const now = Date.now();
    const src = readSource(config);

    if (src.error) {
      // The feed being asked for cannot even be named, so nothing in the cache is known to
      // be about it. Clearing is what stops the widget showing one calendar's meetings
      // under another calendar's settings.
      last = null;
      lastError = src.error;
      return present(null, now, src.error);
    }

    // A different feed entirely. Same rule as the location check in the weather provider,
    // and it exists for the same reason: a kept result is only ever valid for the thing it
    // came from, and a URL edited in the config is a different thing.
    if (last && last.source !== src.source) last = null;

    try {
      const text = src.kind === "url" ? await fetchText(src.value) : await fs.readFile(src.value, "utf8");
      // `readEvents` is total, so a feed that is not a feed reads as zero events rather
      // than throwing. That is a real read of an empty calendar, not a failure, and it is
      // reported as one.
      last = { takenAt: Date.now(), source: src.source, events: readEvents(text) };
      lastError = null;
    } catch (e) {
      // Only here is the cache still worth keeping: the feed was identified, and the
      // request for *that* feed failed. Kept rather than thrown, because the host stores
      // nothing for a provider that throws and one failed poll would blank the widget.
      lastError = e.message ?? String(e);
    }

    const at = Date.now();
    return present(view(at, config?.days), at, lastError);
  },
};

module.exports = { calendar, INTERVAL_MS, TIMEOUT_MS };
