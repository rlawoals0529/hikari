/**
 * Reading an .ics feed, and the four places the format bites.
 *
 * Everything here is pure: unfolding, splitting a property, unescaping text, turning three
 * different date forms into an instant, and choosing which events belong in a window. The
 * provider fetches bytes and does nothing else, which is what makes the hard half testable
 * against a fixture instead of against somebody's calendar.
 *
 * The four traps, in the order they cost you:
 *
 *   1. **Folding.** RFC 5545 breaks a long line by inserting CRLF and a single space or
 *      tab. Unfolding has to happen before any parsing at all: parse first and every long
 *      SUMMARY is silently cut at 73 characters, with the tail left behind as a property
 *      line that parses as nothing. This is the single most important thing in the file.
 *   2. **The parameter colon.** Parameters sit before the value's colon and may contain a
 *      quoted one, as in `ATTENDEE;CN="Smith:Jr":mailto:x`. Splitting on the first colon
 *      full stop puts half the parameters in the value.
 *   3. **Escapes.** Only `\n` `\N` `\,` `\;` and `\\` are escapes. Treating anything else
 *      as one, or unescaping in two passes, shows the user a literal backslash or eats a
 *      real one.
 *   4. **Three date forms.** A date with no time and no zone, a UTC instant, and a local
 *      time in a named zone. They need three different readings and only one of them is
 *      what `Date.parse` would do.
 *
 * And the rule the rest of this repo already lives by: **what it cannot read is null, and
 * one unreadable field costs the others nothing.** A feed with a broken DTEND still has a
 * summary and a start, and an event with neither is still counted rather than pretended
 * away. Nothing here throws on malformed input; it returns what it could read.
 */

const { classify, present: presentReading } = require("./freshness");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a fetched feed stays worth showing.
 *
 * Much longer than a temperature, because the events themselves are dated: an hour-old
 * feed still shows the right time for the meetings it knows about. What an old feed cannot
 * know is a *change* -- a cancellation, or something added this morning -- so what expires
 * is the claim that the list is complete. A day is the point past which that claim is not
 * worth making, and past it the widget says so rather than showing a meeting that may have
 * been called off.
 */
const FRESH_MS = 60 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

const LIFE = {
  freshMs: FRESH_MS,
  staleMs: STALE_MS,
  missing: "no calendar read yet",
  tooOld: "the last calendar read is too old to trust",
};

/** @returns {"fresh" | "stale" | "expired"} */
function freshness(takenAt, now) {
  return classify(takenAt, now, LIFE);
}

/** What to hand the widget: the window, or unknown with the reason. */
function present(reading, now, error) {
  return presentReading(reading, now, error, LIFE);
}

/** The default window. A week is what fits on a widget and what a person plans against. */
const DEFAULT_DAYS = 7;

/**
 * Physical lines as logical ones, folds joined.
 *
 * A continuation line begins with one space or tab, and exactly that one character is the
 * fold marker rather than whitespace in general: the rest is content. Trimming the line
 * instead would delete a leading space that belongs to the value, which is how a folded
 * "Team standup" becomes "Teamstandup".
 *
 * All three line endings are accepted. The spec says CRLF, real feeds served through
 * anything that normalises text arrive as LF, and a file that has been through an old Mac
 * tool arrives as CR. Handling only CRLF means an LF feed reads as a single line and the
 * whole calendar parses as nothing.
 */
function unfold(text) {
  if (typeof text !== "string") return [];
  const lines = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (lines.length > 0 && (raw.startsWith(" ") || raw.startsWith("\t"))) {
      lines[lines.length - 1] += raw.slice(1);
      continue;
    }
    lines.push(raw);
  }
  return lines;
}

/**
 * A logical line as `{ name, params, value }`, or null when there is nothing to read.
 *
 * The split is on the first colon **outside double quotes**, because a parameter value is
 * allowed to contain one and `ATTENDEE;CN="Smith:Jr":mailto:x` is what that looks like.
 * The same scan drives the semicolon split between parameters, for the same reason:
 * `CN="Smith;Jr"` is one parameter, not two.
 *
 * Names and parameter keys are upper-cased. The format is case-insensitive about both, and
 * a feed writing `Summary` would otherwise read as an event with no title.
 */
function splitLine(line) {
  if (typeof line !== "string") return null;
  const colon = indexOutsideQuotes(line, ":");
  // No colon is no value. A bare `BEGIN` or a stray fragment tells us nothing, and it is
  // not worth a slot in the result that a caller then has to test for.
  if (colon === -1) return null;

  const parts = splitOutsideQuotes(line.slice(0, colon), ";");
  const name = (parts.shift() ?? "").trim().toUpperCase();
  if (name === "") return null;

  const params = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    // A parameter with no value carries no information, so it is dropped rather than
    // stored as an empty string that a reader would then have to distinguish from unset.
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    if (key === "") continue;
    params[key] = unquote(part.slice(eq + 1).trim());
  }
  return { name, params, value: line.slice(colon + 1) };
}

/** The first `char` that is not inside a quoted parameter value, or -1. */
function indexOutsideQuotes(text, char) {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (c === char && !quoted) return i;
  }
  return -1;
}

function splitOutsideQuotes(text, char) {
  const out = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (c === char && !quoted) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Surrounding quotes removed, and only a matched pair of them. */
function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

/**
 * A TEXT value with its escapes resolved.
 *
 * Exactly five escapes exist: `\n` and `\N` for a newline, `\,`, `\;` and `\\`. **Nothing
 * else is an escape**, so a lone backslash stays a backslash and `\q` stays two
 * characters. Inventing a sixth is how a Windows path in a LOCATION loses a separator.
 *
 * One pass, with the backslash inside the pattern, and that is load-bearing. Replacing
 * `\\` and then `\n` in sequence turns the two-character sequence "backslash, n" -- which
 * is a literal backslash followed by the letter n -- into a newline, because the first
 * pass leaves behind an escape the second pass then honours. One pass consumes the pair
 * and moves past it.
 */
function unescapeText(value) {
  if (typeof value !== "string") return null;
  return value.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

const DATE_ONLY = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

/**
 * A DTSTART or DTEND as `{ ms, allDay }`, or null.
 *
 * The **shape of the value decides**, not the VALUE parameter. `20260910` is a date and
 * `20260910T140000Z` is an instant whatever the parameters claim, and plenty of feeds omit
 * `VALUE=DATE` on an all-day event -- trusting the parameter would read those as a
 * midnight appointment and print "00:00" beside a birthday.
 *
 * The three forms:
 *
 *   - `20260910` -- a floating date, anchored to **local** midnight. Anchoring it to UTC
 *     midnight is the classic off-by-one-day calendar bug: west of Greenwich an all-day
 *     event then begins the previous evening and shows up under yesterday.
 *   - `20260910T140000Z` -- a real instant, read as one.
 *   - `20260910T140000` with `TZID=Europe/London` -- a wall clock in a named zone, which
 *     has to be converted. With no TZID it is a floating local time, which is the one form
 *     `new Date(...)` would get right by accident.
 */
function readDate(value, params) {
  if (typeof value !== "string") return null;
  const text = value.trim();

  const date = DATE_ONLY.exec(text);
  if (date) {
    const ms = localMs(+date[1], +date[2], +date[3], 0, 0, 0);
    return ms === null ? null : { ms, allDay: true };
  }

  const stamp = DATE_TIME.exec(text);
  if (!stamp) return null;
  const [, y, mo, d, h, mi, s, zulu] = stamp;
  const fields = [+y, +mo, +d, +h, +mi, +s];

  if (zulu === "Z") {
    const ms = Date.UTC(...withMonthIndex(fields));
    return Number.isFinite(ms) ? { ms, allDay: false } : null;
  }

  const tzid = typeof params?.TZID === "string" ? params.TZID.trim() : "";
  if (tzid !== "") {
    const ms = zonedMs(tzid, fields);
    // A zone name Intl does not know falls back to local time rather than dropping the
    // event. Outlook writes `TZID=GMT Standard Time`, which is not an IANA name and throws
    // in the Intl constructor; a personal feed carrying one was almost certainly written in
    // the zone the reader is sitting in, so local is wrong by an offset at worst, while
    // dropping the event is wrong by the whole appointment.
    if (ms !== null) return { ms, allDay: false };
  }

  const ms = localMs(...fields);
  return ms === null ? null : { ms, allDay: false };
}

function withMonthIndex([y, mo, d, h, mi, s]) {
  return [y, mo - 1, d, h, mi, s];
}

function localMs(...fields) {
  const [y, mo, d, h, mi, s] = withMonthIndex(fields);
  const ms = new Date(y, mo, d, h, mi, s, 0).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A wall clock in a named zone as an instant, or null if the zone is not one Intl knows.
 *
 * Two passes, and the second is not optional. The first pass asks for the zone's offset at
 * the instant the fields would be if they were UTC, which is up to a day away from the
 * real one and can therefore land on the wrong side of a daylight-saving change. Applying
 * that offset gives an instant close enough to ask again, and the second answer is right
 * for the actual moment. A single pass is off by an hour for two days a year, which is the
 * kind of bug that gets blamed on the feed.
 */
function zonedMs(tzid, fields) {
  const wall = Date.UTC(...withMonthIndex(fields));
  if (!Number.isFinite(wall)) return null;
  const rough = zoneOffset(tzid, wall);
  if (rough === null) return null;
  const refined = zoneOffset(tzid, wall - rough);
  return refined === null ? null : wall - refined;
}

/** A zone's offset from UTC at an instant, in ms, or null if the zone is unknown. */
function zoneOffset(tzid, ms) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      // h23 rather than hour12:false, which renders midnight as hour 24 on some builds and
      // would put the offset out by a day.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(ms);
  } catch {
    return null;
  }
  const f = {};
  for (const p of parts) f[p.type] = p.value;
  const asUtc = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute, +f.second);
  return Number.isFinite(asUtc) ? asUtc - ms : null;
}

const DURATION = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * A DURATION as milliseconds, or null.
 *
 * Supported because DTEND is not the only way to say when an event ends, and without this
 * an event written with `DURATION:PT1H` reads as zero length and vanishes from the widget
 * the moment it starts -- which looks exactly like a meeting being cancelled as you walk
 * into it. Weeks and days are counted as fixed lengths, which is what the spec says for a
 * nominal duration read against a UTC instant and close enough for a window measured in
 * days.
 */
function readDuration(value) {
  if (typeof value !== "string") return null;
  const m = DURATION.exec(value.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  // A bare "P" matches the pattern with every group empty. It is not a duration, and
  // returning 0 for it would be a length this feed never stated.
  if (![w, d, h, mi, s].some((part) => part !== undefined)) return null;
  const ms =
    (+(w ?? 0) * 7 + +(d ?? 0)) * DAY_MS +
    +(h ?? 0) * 3600000 +
    +(mi ?? 0) * 60000 +
    +(s ?? 0) * 1000;
  return sign === "-" ? -ms : ms;
}

/** The properties an event is built from. Anything else in a VEVENT is not read. */
const WANTED = new Set(["UID", "SUMMARY", "LOCATION", "DTSTART", "DTEND", "DURATION"]);

/**
 * Every VEVENT in a feed, in the order the feed listed them.
 *
 * Total by construction: a line that does not parse is skipped, an event that cannot be
 * dated is still returned with the fields it did have, and a feed that is not a feed comes
 * back as an empty array. A calendar widget that throws takes the whole poll down with it,
 * and the poll serves every other provider too.
 */
function readEvents(text) {
  const events = [];
  /** The VEVENT being collected, or null between them. */
  let open = null;
  /**
   * How deep inside a nested component we are, and this is not bookkeeping for its own
   * sake. A VALARM lives *inside* a VEVENT and carries its own SUMMARY and DESCRIPTION, so
   * a parser that reads every line between BEGIN:VEVENT and END:VEVENT lets the reminder's
   * text overwrite the meeting's title. Lines below depth zero are skipped entirely.
   */
  let depth = 0;

  for (const line of unfold(text)) {
    const prop = splitLine(line);
    if (!prop) continue;
    const { name, params, value } = prop;

    if (name === "BEGIN") {
      const kind = value.trim().toUpperCase();
      if (!open) {
        if (kind === "VEVENT") open = { props: new Map() };
      } else if (kind === "VEVENT") {
        // A second BEGIN:VEVENT with no END between them. The first event is finished with
        // what it has rather than merged into the second, which would produce one event
        // wearing two titles.
        events.push(buildEvent(open));
        open = { props: new Map() };
        depth = 0;
      } else {
        depth++;
      }
      continue;
    }

    if (name === "END") {
      if (!open) continue;
      if (depth > 0) {
        depth--;
        continue;
      }
      if (value.trim().toUpperCase() === "VEVENT") {
        events.push(buildEvent(open));
        open = null;
      }
      continue;
    }

    if (!open || depth > 0) continue;
    if (!WANTED.has(name)) continue;
    // First occurrence wins. These properties occur once per event, so a second one means
    // a feed that has been merged or hand-edited badly, and the later line is the one more
    // likely to be the stray. Last-wins would let it silently replace the real title.
    if (!open.props.has(name)) open.props.set(name, { params, value });
  }

  // A VEVENT the file never closed, because the feed was truncated in transit or the
  // writer was interrupted. The properties it did carry are real, and discarding them
  // would hide the next appointment because a byte stream ended early.
  if (open) events.push(buildEvent(open));
  return events;
}

function buildEvent(open) {
  const prop = (name) => open.props.get(name) ?? null;
  const textOf = (name) => {
    const p = prop(name);
    if (!p) return null;
    const out = unescapeText(p.value);
    // An empty SUMMARY is an untitled event, not an event titled "". Null keeps it on the
    // one code path the widget already has for a field it does not know.
    return out === null || out.trim() === "" ? null : out;
  };

  const startProp = prop("DTSTART");
  const start = startProp ? readDate(startProp.value, startProp.params) : null;
  const allDay = start?.allDay === true;

  return {
    uid: textOf("UID"),
    summary: textOf("SUMMARY"),
    location: textOf("LOCATION"),
    start: start ? start.ms : null,
    end: start ? endOf(open, start, allDay) : null,
    allDay,
  };
}

/**
 * When an event finishes.
 *
 * DTEND is **exclusive**, and it stays exclusive here. An all-day event on the 10th is
 * written `DTSTART;VALUE=DATE:20260910` with `DTEND;VALUE=DATE:20260911`, and "correcting"
 * that to the 10th so it reads inclusively makes the event end at midnight on the morning
 * of the day it is on -- so it is filtered out as already over for the entire day it
 * actually occupies.
 *
 * With no DTEND: an all-day event lasts the one day the spec gives it, and a timed event
 * with neither DTEND nor DURATION has no length at all, which is what the spec says and
 * what a reminder-style entry means.
 */
function endOf(open, start, allDay) {
  const dtend = open.props.get("DTEND");
  if (dtend) {
    const end = readDate(dtend.value, dtend.params);
    // An end before its start is not information. Falling through to the default is better
    // than reporting a negative length that every reader downstream has to guard against.
    if (end && end.ms >= start.ms) return end.ms;
  }

  const duration = open.props.get("DURATION");
  if (duration) {
    const ms = readDuration(duration.value);
    if (ms !== null && ms >= 0) return start.ms + ms;
  }

  // A day later by the calendar, not by 86,400,000 milliseconds. Adding a fixed day across
  // a daylight-saving change lands at 23:00 or 01:00, and for a value that is supposed to
  // be a date that is the wrong day.
  if (allDay) {
    const next = new Date(start.ms);
    next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  return start.ms;
}

/**
 * Whether an event is over at `now`.
 *
 * The boundary favours showing an event for the instant it ends: a meeting disappearing on
 * the exact second of its end time reads as a glitch, and a zero-length entry must not be
 * born already over.
 */
function hasEnded(event, now) {
  if (!event || !Number.isFinite(event.start) || !Number.isFinite(now)) return false;
  const finish = Number.isFinite(event.end) && event.end > event.start ? event.end : event.start;
  return finish < now;
}

/**
 * The window a config asks for, in days.
 *
 * Anything that is not a positive number falls back to a week rather than to zero. Zero
 * days is an empty widget, and "days": "seven" in a config file would otherwise produce
 * one and look like a calendar with nothing in it.
 */
function windowDays(days) {
  const n = typeof days === "number" || typeof days === "string" ? Number(days) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAYS;
}

/**
 * The events worth showing: sorted, inside the window, and not already over.
 *
 * An event in progress is still coming up as far as a reader is concerned, so the filter
 * is on whether it has *ended*, not on whether it has started. An event with no readable
 * start is dropped here rather than in `readEvents`, because "when" is the one field a
 * window cannot do without -- but the parser still returned it, so a caller can tell a
 * feed with unreadable events from a feed with none.
 */
function upcoming(events, now, days) {
  if (!Array.isArray(events) || !Number.isFinite(now)) return [];
  const until = now + windowDays(days) * DAY_MS;
  return events
    .filter((e) => e && Number.isFinite(e.start) && e.start < until && !hasEnded(e, now))
    .sort(
      (a, b) =>
        a.start - b.start ||
        // A stable order for events that start together, so a redraw does not shuffle them
        // and read as movement that means something.
        String(a.summary ?? "").localeCompare(String(b.summary ?? "")) ||
        String(a.uid ?? "").localeCompare(String(b.uid ?? "")),
    );
}

/**
 * Which feed a config names, or the mistake to report instead.
 *
 * Refused rather than guessed, in every one of the three ways it can be wrong. With both
 * `url` and `file` set there is no right answer, and picking one silently means a user
 * edits the other and nothing changes -- a setting that looks like it worked, which is the
 * worst way for a setting to be wrong.
 *
 * The `source` string is what the cache is keyed on. A kept feed is only ever about the
 * calendar it came from, and forgetting that is how a widget shows last week's meetings
 * from a URL the config no longer names.
 *
 * @returns {{kind: "url" | "file", value: string, source: string} | {error: string}}
 */
function readSource(config) {
  const url = typeof config?.url === "string" ? config.url.trim() : "";
  const file = typeof config?.file === "string" ? config.file.trim() : "";

  if (url !== "" && file !== "") {
    return { error: 'both "url" and "file" are set under providers.calendar; keep one' };
  }

  if (url !== "") {
    // webcal:// is what a calendar app hands you when you ask to share a feed, and it is
    // https in every respect except the scheme. Rewritten as text before parsing, because
    // the URL protocol setter refuses to move between a non-special scheme and a special
    // one and does it by doing nothing at all, which would leave the scheme untouched and
    // the check below rejecting a URL the user copied from the place it is meant to come
    // from.
    const https = url.replace(/^webcal:/i, "https:");
    let parsed;
    try {
      parsed = new URL(https);
    } catch {
      return { error: `"${url}" is not a URL` };
    }
    // https only, and this is a security decision rather than tidiness. The subscription
    // URL *is* the credential for the calendar, so http would put a token that reads every
    // appointment onto the wire in clear, on every poll, forever. A local file covers the
    // case where a feed genuinely has no TLS.
    if (parsed.protocol !== "https:") {
      return { error: `${parsed.protocol}// is not supported; a subscription URL must be https` };
    }
    const value = parsed.toString();
    return { kind: "url", value, source: `url:${value}` };
  }

  if (file !== "") return { kind: "file", value: file, source: `file:${file}` };

  return {
    error: 'set "url" or "file" under providers.calendar in ~/.hikari/config.json',
  };
}

module.exports = {
  DAY_MS,
  DEFAULT_DAYS,
  FRESH_MS,
  STALE_MS,
  freshness,
  present,
  unfold,
  splitLine,
  unescapeText,
  readDate,
  readDuration,
  readEvents,
  hasEnded,
  windowDays,
  upcoming,
  readSource,
};
