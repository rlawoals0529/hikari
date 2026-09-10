const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
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
} = require("../src/lib/ics");

/** A backslash, built rather than written, so no layer of quoting can lose one. */
const B = String.fromCharCode(92);

/** CRLF, because the format says CRLF and a fixture written with LF would not test folding
 *  the way a real feed exercises it. */
const CRLF = "\r\n";

/**
 * A real multi-event feed, written the way a server sends one: CRLF endings, a folded
 * SUMMARY, an all-day event with an exclusive DTEND, a zoned event, a UTC event, an event
 * with no UID, a VALARM inside a VEVENT, and escaped text.
 *
 * Assembled from lines rather than pasted as one string so the fold is visibly a fold: the
 * continuation lines start with a single space and that is the whole mechanism.
 *
 * The all-day event is dated more than a day clear of every timed one on purpose. A DATE
 * value is only fixed to within a day until you know the reader's zone, so an all-day event
 * next to a timed one sorts differently in Auckland than in Los Angeles -- and a test
 * asserting a fixed order would then be asserting something false, in a suite that has to
 * pass wherever it is run.
 */
const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//hikari//test//EN",
  "BEGIN:VEVENT",
  "UID:aaa@example.com",
  "DTSTAMP:20260908T090000Z",
  "DTSTART:20260910T140000Z",
  "DTEND:20260910T150000Z",
  "SUMMARY:Quarterly planning review with the whole of platform engineering an",
  " d a guest from design",
  "LOCATION:Room 3",
  "BEGIN:VALARM",
  "TRIGGER:-PT10M",
  "ACTION:DISPLAY",
  "SUMMARY:Reminder",
  "DESCRIPTION:Quarterly planning review",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:bbb@example.com",
  "DTSTART;VALUE=DATE:20260912",
  "DTEND;VALUE=DATE:20260913",
  "SUMMARY:Company holiday",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:ccc@example.com",
  "DTSTART;TZID=Europe/London:20260914T090000",
  "DTEND;TZID=Europe/London:20260914T093000",
  "SUMMARY:Standup",
  "ATTENDEE;CN=" + '"Smith:Jr"' + ":mailto:smith@example.com",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20260915T110000Z",
  "SUMMARY:Coffee with Ana" + B + ", who is visiting",
  "LOCATION:Cafe" + B + "; corner table",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join(CRLF);

const NOW = Date.UTC(2026, 8, 9, 12, 0);

// -- unfolding ---------------------------------------------------------------------------

test("a folded SUMMARY comes back whole", () => {
  // The single most important thing in the module. Parsing before unfolding cuts every long
  // summary at the fold and leaves the tail as a line that parses as nothing, so the widget
  // shows a title that stops mid-word and no error anywhere.
  const events = readEvents(FEED);
  assert.equal(
    events[0].summary,
    "Quarterly planning review with the whole of platform engineering and a guest from design",
  );
});

test("the fold marker is one character, not the whitespace run after it", () => {
  // Only the single space or tab is the fold. Trimming the continuation instead deletes a
  // space that belongs to the value, and "Team standup" arrives as "Teamstandup".
  assert.deepEqual(unfold("SUMMARY:Team" + CRLF + "  standup"), ["SUMMARY:Team standup"]);
  assert.deepEqual(unfold("SUMMARY:Team" + CRLF + "\t standup"), ["SUMMARY:Team standup"]);
});

test("a tab continues a line as well as a space", () => {
  assert.deepEqual(unfold("A:one" + CRLF + "\ttwo"), ["A:onetwo"]);
});

test("bare LF endings unfold too, because that is what a normalised feed arrives as", () => {
  // A feed served through anything that rewrites text arrives as LF. Handling only CRLF
  // makes the whole calendar one logical line, and it parses as nothing at all.
  assert.deepEqual(unfold("A:one\n two\nB:three"), ["A:onetwo", "B:three"]);
});

test("bare CR endings unfold too", () => {
  assert.deepEqual(unfold("A:one\r two\rB:three"), ["A:onetwo", "B:three"]);
});

test("mixed CRLF and LF in one feed do not merge two lines into one", () => {
  assert.deepEqual(unfold("A:one" + CRLF + "B:two\nC:three"), ["A:one", "B:two", "C:three"]);
});

test("several folds in a row join into one line", () => {
  assert.deepEqual(unfold("A:a" + CRLF + " b" + CRLF + " c" + CRLF + " d"), ["A:abcd"]);
});

test("unfolding anything that is not text is an empty list, not a throw", () => {
  for (const v of [null, undefined, 42, {}, []]) assert.deepEqual(unfold(v), [], String(v));
});

// -- property lines ----------------------------------------------------------------------

test("a property splits into a name, its parameters and its value", () => {
  const p = splitLine("DTSTART;VALUE=DATE:20260910");
  assert.equal(p.name, "DTSTART");
  assert.deepEqual(p.params, { VALUE: "DATE" });
  assert.equal(p.value, "20260910");
});

test("a quoted colon in a parameter is not the value's colon", () => {
  // The trap: splitting on the first colon full stop puts half the parameters in the value,
  // and this is a line real feeds contain.
  const p = splitLine("ATTENDEE;CN=" + '"Smith:Jr"' + ":mailto:smith@example.com");
  assert.equal(p.name, "ATTENDEE");
  assert.deepEqual(p.params, { CN: "Smith:Jr" });
  assert.equal(p.value, "mailto:smith@example.com");
});

test("a quoted semicolon is one parameter, not two", () => {
  const p = splitLine("ATTENDEE;CN=" + '"Smith;Jr"' + ";ROLE=CHAIR:mailto:x@example.com");
  assert.deepEqual(p.params, { CN: "Smith;Jr", ROLE: "CHAIR" });
  assert.equal(p.value, "mailto:x@example.com");
});

test("a colon inside the value is left alone", () => {
  assert.equal(splitLine("SUMMARY:Standup: platform").value, "Standup: platform");
});

test("names and parameter keys are case-insensitive, values are not", () => {
  // The format is case-insensitive about both. A feed writing `Summary` would otherwise
  // read as an event with no title.
  const p = splitLine("dtstart;tzid=Europe/London:20260910T090000");
  assert.equal(p.name, "DTSTART");
  assert.deepEqual(p.params, { TZID: "Europe/London" });
});

test("a line with no colon reads as nothing rather than as a nameless property", () => {
  for (const line of ["BEGIN", "", "   ", ":no name", null, 42]) {
    assert.equal(splitLine(line), null, String(line));
  }
});

test("a parameter with no value is dropped rather than stored as empty", () => {
  const p = splitLine("DTSTART;BROKEN;VALUE=DATE:20260910");
  assert.deepEqual(p.params, { VALUE: "DATE" });
});

test("an empty value is an empty string, which is not the same as no value", () => {
  const p = splitLine("SUMMARY:");
  assert.equal(p.value, "");
});

// -- text escapes ------------------------------------------------------------------------

test("every escape the format has, and only those", () => {
  assert.equal(unescapeText("line" + B + "none"), "line\none");
  assert.equal(unescapeText("line" + B + "None"), "line\none");
  assert.equal(unescapeText("Smith" + B + ", Jr"), "Smith, Jr");
  assert.equal(unescapeText("a" + B + ";b"), "a;b");
  assert.equal(unescapeText("C:" + B + B + "Users"), "C:" + B + "Users");
});

test("a lone backslash is not an escape and stays exactly where it is", () => {
  // Inventing a sixth escape is how a Windows path in a LOCATION loses a separator, and
  // the user sees a directory that does not exist.
  assert.equal(unescapeText("a" + B + "qb"), "a" + B + "qb");
  assert.equal(unescapeText("trailing" + B), "trailing" + B);
  assert.equal(unescapeText(B + "t"), B + "t");
});

test("an escaped backslash does not then escape the character after it", () => {
  // The bug this caught while it was being written. The character class in the pattern was
  // missing the backslash itself, so "backslash, backslash, n" -- a literal backslash
  // followed by the letter n -- came out as a backslash and a newline. One pass with the
  // backslash inside the pattern consumes the pair and moves past it.
  assert.equal(unescapeText(B + B + "n"), B + "n");
  assert.equal(unescapeText(B + B + B + "n"), B + "\n");
});

test("unescaping anything that is not text is null, never a string", () => {
  for (const v of [null, undefined, 42, {}]) assert.equal(unescapeText(v), null, String(v));
});

// -- the three date forms ----------------------------------------------------------------

test("a DATE value is all-day and anchored to local midnight", () => {
  // Local, not UTC. A UTC anchor puts an all-day event on the previous evening for anyone
  // west of Greenwich, which is the classic off-by-one-day calendar bug.
  const d = readDate("20260910", { VALUE: "DATE" });
  assert.equal(d.allDay, true);
  assert.deepEqual(
    [new Date(d.ms).getFullYear(), new Date(d.ms).getMonth(), new Date(d.ms).getDate()],
    [2026, 8, 10],
  );
  assert.equal(new Date(d.ms).getHours(), 0);
  assert.equal(new Date(d.ms).getMinutes(), 0);
});

test("the shape of the value decides, so a DATE with no VALUE parameter is still all-day", () => {
  // Plenty of feeds omit VALUE=DATE. Trusting the parameter reads those as a midnight
  // appointment and prints "00:00" beside a birthday.
  assert.equal(readDate("20260910", {}).allDay, true);
});

test("a Z value is a real instant, read as one", () => {
  const d = readDate("20260910T140000Z", {});
  assert.equal(d.allDay, false);
  assert.equal(d.ms, Date.UTC(2026, 8, 10, 14, 0, 0));
});

test("a zoned value is converted out of its own zone, not the machine's", () => {
  // 09:00 in London on this date is 08:00 UTC, whatever zone the test is running in. A
  // reading that used the machine's zone would only be right in Britain.
  const d = readDate("20260912T090000", { TZID: "Europe/London" });
  assert.equal(d.allDay, false);
  assert.equal(d.ms, Date.UTC(2026, 8, 12, 8, 0, 0));
});

test("a zoned value across the world lands where the zone says", () => {
  assert.equal(readDate("20260912T090000", { TZID: "Asia/Tokyo" }).ms, Date.UTC(2026, 8, 12, 0, 0, 0));
  assert.equal(readDate("20260912T090000", { TZID: "America/New_York" }).ms, Date.UTC(2026, 8, 12, 13, 0, 0));
  assert.equal(readDate("20260912T090000", { TZID: "UTC" }).ms, Date.UTC(2026, 8, 12, 9, 0, 0));
});

test("a zoned value uses the offset in force on its own side of the year", () => {
  assert.equal(readDate("20260115T090000", { TZID: "Europe/London" }).ms, Date.UTC(2026, 0, 15, 9, 0, 0));
  assert.equal(readDate("20260715T090000", { TZID: "Europe/London" }).ms, Date.UTC(2026, 6, 15, 8, 0, 0));
});

test("a zoned value beside a clock change uses the offset of the real instant", () => {
  // Why the conversion runs twice, and this is the case that proves it rather than merely
  // asserting it. Auckland moves to NZDT at 02:00 local on 27 September 2026, which is
  // 14:00Z on the 26th. Midnight local on the 27th is still NZST at +12 -- but the fields
  // treated as UTC land at 00:00Z on the 27th, *after* the transition, so the first pass is
  // told +13. Asking again at the instant that offset produces gives +12, which is the one
  // in force. A single pass puts this event an hour early, which is the sort of bug that
  // gets blamed on the feed.
  assert.equal(
    readDate("20260927T000000", { TZID: "Pacific/Auckland" }).ms,
    Date.UTC(2026, 8, 26, 12, 0, 0),
  );
});

test("a zone name Intl has never heard of falls back to local time, not to nothing", () => {
  // Outlook writes TZID=GMT Standard Time, which is not an IANA name. Dropping the event
  // is wrong by the whole appointment; reading it as local time is wrong by an offset at
  // worst, and a personal feed carrying one was written in the reader's own zone anyway.
  const d = readDate("20260912T090000", { TZID: "GMT Standard Time" });
  assert.equal(d.ms, new Date(2026, 8, 12, 9, 0, 0).getTime());
  assert.equal(d.allDay, false);
});

test("a value with no zone and no Z is a floating local time", () => {
  assert.equal(readDate("20260912T090000", {}).ms, new Date(2026, 8, 12, 9, 0, 0).getTime());
});

test("a date that is not a date is null rather than an invented instant", () => {
  for (const v of ["", "tomorrow", "2026-09-10", "20260910T1400", "202609", null, 42, {}]) {
    assert.equal(readDate(v, {}), null, JSON.stringify(v));
  }
});

// -- durations ---------------------------------------------------------------------------

test("a duration reads as milliseconds", () => {
  assert.equal(readDuration("PT1H"), 3600000);
  assert.equal(readDuration("PT30M"), 30 * 60000);
  assert.equal(readDuration("PT1H30M"), 90 * 60000);
  assert.equal(readDuration("P1D"), DAY_MS);
  assert.equal(readDuration("P1W"), 7 * DAY_MS);
  assert.equal(readDuration("P1DT2H3M4S"), DAY_MS + 2 * 3600000 + 3 * 60000 + 4000);
  assert.equal(readDuration("-PT10M"), -10 * 60000);
});

test("a bare P is not a zero-length duration, it is not a duration", () => {
  // Zero would be a length this feed never stated, and it would then be used as one.
  for (const v of ["P", "PT", "", "1H", "PT1X", null, 42]) {
    assert.equal(readDuration(v), null, JSON.stringify(v));
  }
});

// -- reading a feed ----------------------------------------------------------------------

test("the fixture reads as four events, in the order the feed listed them", () => {
  const events = readEvents(FEED);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.uid), [
    "aaa@example.com",
    "bbb@example.com",
    "ccc@example.com",
    null,
  ]);
});

test("a timed event carries its start, its end and its location", () => {
  const [first] = readEvents(FEED);
  assert.equal(first.start, Date.UTC(2026, 8, 10, 14, 0));
  assert.equal(first.end, Date.UTC(2026, 8, 10, 15, 0));
  assert.equal(first.allDay, false);
  assert.equal(first.location, "Room 3");
});

test("a VALARM inside an event does not overwrite the event's own summary", () => {
  // A VALARM carries its own SUMMARY and DESCRIPTION. A parser that reads every line
  // between BEGIN:VEVENT and END:VEVENT lets the reminder's text become the meeting title.
  const [first] = readEvents(FEED);
  assert.match(first.summary, /^Quarterly planning review with the whole/);
  assert.notEqual(first.summary, "Reminder");
});

test("a VALARM listed before the event's own properties still does not win", () => {
  // The fixture has the alarm after the summary, so first-occurrence-wins hides the bug
  // there: skipping the nested component is what actually stops the reminder's text and
  // the reminder's own dates reaching the event. A feed is free to order them either way,
  // and one that puts the alarm first is the one that breaks a parser without this.
  const [event] = readEvents(
    [
      "BEGIN:VEVENT",
      "UID:x",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "SUMMARY:Reminder",
      "DTSTART:20200101T000000Z",
      "END:VALARM",
      "SUMMARY:Real meeting",
      "DTSTART:20260910T140000Z",
      "END:VEVENT",
    ].join(CRLF),
  );
  assert.equal(event.summary, "Real meeting");
  assert.equal(event.start, Date.UTC(2026, 8, 10, 14, 0));
});

test("an all-day event keeps its exclusive end", () => {
  // DTEND is exclusive and it stays exclusive. "Correcting" it to the last day makes the
  // event end at midnight on the morning of the day it is on, so it filters out as already
  // over for the whole of that day.
  const holiday = readEvents(FEED)[1];
  assert.equal(holiday.allDay, true);
  assert.equal(holiday.start, new Date(2026, 8, 12).getTime());
  assert.equal(holiday.end, new Date(2026, 8, 13).getTime());
});

test("an all-day event with no DTEND lasts exactly the one day", () => {
  const [event] = readEvents(["BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260911", "SUMMARY:x", "END:VEVENT"].join(CRLF));
  assert.equal(event.end, new Date(2026, 8, 12).getTime());
});

test("an all-day event over a clock change still ends on the next day, not at 23:00", () => {
  // The reason the day is added by the calendar and not as 86,400,000 milliseconds. In
  // Europe the clocks go back on 25 October 2026.
  const [event] = readEvents(["BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261025", "SUMMARY:x", "END:VEVENT"].join(CRLF));
  assert.equal(event.end, new Date(2026, 9, 26).getTime());
  assert.equal(new Date(event.end).getHours(), 0);
});

test("a zoned event reads out of its zone inside a whole feed too", () => {
  const standup = readEvents(FEED)[2];
  assert.equal(standup.start, Date.UTC(2026, 8, 14, 8, 0));
  assert.equal(standup.end, Date.UTC(2026, 8, 14, 8, 30));
});

test("an event with no UID is still an event", () => {
  // UID is required by the spec and missing in real feeds anyway. Dropping the event would
  // hide a real appointment over a field nothing on screen uses.
  const coffee = readEvents(FEED)[3];
  assert.equal(coffee.uid, null);
  assert.equal(coffee.summary, "Coffee with Ana, who is visiting");
  assert.equal(coffee.location, "Cafe; corner table");
});

test("an event with no DTEND and no duration has no length, and is not dropped", () => {
  const [event] = readEvents(["BEGIN:VEVENT", "UID:x", "DTSTART:20260910T140000Z", "SUMMARY:Ping", "END:VEVENT"].join(CRLF));
  assert.equal(event.start, Date.UTC(2026, 8, 10, 14, 0));
  assert.equal(event.end, event.start);
});

test("a DURATION stands in for a missing DTEND", () => {
  // Without this the event reads as zero length and vanishes from the widget the moment it
  // starts, which looks exactly like a meeting being cancelled as you walk into it.
  const [event] = readEvents(["BEGIN:VEVENT", "DTSTART:20260910T140000Z", "DURATION:PT1H", "SUMMARY:x", "END:VEVENT"].join(CRLF));
  assert.equal(event.end, Date.UTC(2026, 8, 10, 15, 0));
});

test("a DTEND before its DTSTART is ignored rather than reported as a negative length", () => {
  const [event] = readEvents(["BEGIN:VEVENT", "DTSTART:20260910T140000Z", "DTEND:20260910T130000Z", "SUMMARY:x", "END:VEVENT"].join(CRLF));
  assert.equal(event.end, event.start);
});

test("a VEVENT that never ends is still returned with what it did carry", () => {
  // A truncated feed, or a writer interrupted mid-file. Discarding it would hide the next
  // appointment because a byte stream ended early.
  const events = readEvents(
    ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "DTSTART:20260910T140000Z", "SUMMARY:Cut short"].join(CRLF),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, "Cut short");
  assert.equal(events[0].start, Date.UTC(2026, 8, 10, 14, 0));
});

test("a VEVENT left open by END:VCALENDAR is still returned", () => {
  const events = readEvents(
    ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "SUMMARY:Open", "END:VCALENDAR"].join(CRLF),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, "Open");
});

test("a second BEGIN:VEVENT with no END between them makes two events, not one hybrid", () => {
  const events = readEvents(
    ["BEGIN:VEVENT", "SUMMARY:first", "BEGIN:VEVENT", "SUMMARY:second", "END:VEVENT"].join(CRLF),
  );
  assert.deepEqual(events.map((e) => e.summary), ["first", "second"]);
});

test("a duplicated property keeps the first, so a stray line cannot replace a real title", () => {
  const [event] = readEvents(
    ["BEGIN:VEVENT", "SUMMARY:real", "SUMMARY:stray", "END:VEVENT"].join(CRLF),
  );
  assert.equal(event.summary, "real");
});

test("an empty summary is an untitled event rather than an event titled nothing", () => {
  const [event] = readEvents(["BEGIN:VEVENT", "SUMMARY:", "LOCATION:   ", "END:VEVENT"].join(CRLF));
  assert.equal(event.summary, null);
  assert.equal(event.location, null);
});

test("an event with an unreadable start is still returned, with a null start", () => {
  // Returned rather than dropped, so a caller can tell a feed with broken events from a
  // feed with none. It cannot appear in a window, because a window needs a "when".
  const [event] = readEvents(["BEGIN:VEVENT", "UID:x", "DTSTART:nonsense", "SUMMARY:Vague", "END:VEVENT"].join(CRLF));
  assert.equal(event.start, null);
  assert.equal(event.end, null);
  assert.equal(event.summary, "Vague");
});

test("an empty calendar reads as no events, which is not an error", () => {
  const events = readEvents(["BEGIN:VCALENDAR", "VERSION:2.0", "END:VCALENDAR"].join(CRLF));
  assert.deepEqual(events, []);
});

test("garbage in reads as an empty list rather than throwing", () => {
  // A calendar widget that throws takes the whole poll down, and the poll serves every
  // other provider too.
  for (const junk of [
    null,
    undefined,
    "",
    42,
    {},
    [],
    "<!doctype html><title>404 Not Found</title>",
    "BEGIN:VEVENT",
    "END:VEVENT",
    "DTSTART:20260910T140000Z",
    ":::::",
    "BEGIN:VEVENT" + CRLF + "DTSTART" + CRLF + "END:VEVENT",
  ]) {
    assert.doesNotThrow(() => readEvents(junk), JSON.stringify(junk));
    assert.ok(Array.isArray(readEvents(junk)), JSON.stringify(junk));
  }
});

test("a feed of only nested components produces no events", () => {
  const events = readEvents(
    ["BEGIN:VCALENDAR", "BEGIN:VTIMEZONE", "TZID:Europe/London", "BEGIN:DAYLIGHT", "TZNAME:BST", "END:DAYLIGHT", "END:VTIMEZONE", "END:VCALENDAR"].join(CRLF),
  );
  assert.deepEqual(events, []);
});

// -- the window ---------------------------------------------------------------------------

test("the window is sorted, and starts with what is next", () => {
  const events = upcoming(readEvents(FEED), NOW, 7);
  assert.deepEqual(events.map((e) => e.uid), ["aaa@example.com", "bbb@example.com", "ccc@example.com", null]);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].start >= events[i - 1].start);
});

test("an event that has already ended is not upcoming", () => {
  const events = upcoming(readEvents(FEED), Date.UTC(2026, 8, 11, 12, 0), 7);
  assert.ok(!events.some((e) => e.uid === "aaa@example.com"));
});

test("an event in progress is still upcoming, because it has not ended", () => {
  // The filter is on whether it has ended, not on whether it has started. Dropping an event
  // the moment it begins removes the one thing a person is most likely to be looking for.
  const events = upcoming(readEvents(FEED), Date.UTC(2026, 8, 10, 14, 30), 7);
  assert.equal(events[0].uid, "aaa@example.com");
});

test("an all-day event stays upcoming for the whole of its own day", () => {
  // The exclusive DTEND earning its keep. An inclusive end would filter this out at
  // midnight on the morning of the day it is on.
  const events = upcoming(readEvents(FEED), new Date(2026, 8, 12, 15, 0).getTime(), 7);
  assert.ok(events.some((e) => e.uid === "bbb@example.com"));
});

test("a window shorter than the feed cuts it off at the window, not at the day", () => {
  // The first event is 26 hours out, so a one-day window genuinely holds nothing: the
  // window is measured from now, not rounded to a calendar day. Written as both halves
  // because a test asserting only the empty one would pass against a window of zero.
  assert.deepEqual(upcoming(readEvents(FEED), NOW, 1), []);
  assert.deepEqual(upcoming(readEvents(FEED), NOW, 4).map((e) => e.uid), [
    "aaa@example.com",
    "bbb@example.com",
  ]);
});

test("an event with no start cannot be in a window", () => {
  const events = readEvents(["BEGIN:VEVENT", "SUMMARY:Vague", "END:VEVENT"].join(CRLF));
  assert.equal(events.length, 1);
  assert.deepEqual(upcoming(events, NOW, 7), []);
});

test("a zero-length event is not born already over", () => {
  const event = { start: NOW, end: NOW, allDay: false, summary: "Ping", uid: "x", location: null };
  assert.equal(hasEnded(event, NOW), false);
  assert.equal(hasEnded(event, NOW + 1), true);
});

test("an event is shown for the instant it ends, not hidden on the second", () => {
  const event = { start: NOW, end: NOW + 3600000, allDay: false, summary: "x", uid: "x", location: null };
  assert.equal(hasEnded(event, NOW + 3600000), false);
  assert.equal(hasEnded(event, NOW + 3600001), true);
});

test("events that start together keep a stable order across calls", () => {
  // Otherwise a redraw shuffles them and reads as movement that means something.
  const events = [
    { start: NOW, end: NOW, summary: "b", uid: "2", allDay: false, location: null },
    { start: NOW, end: NOW, summary: "a", uid: "1", allDay: false, location: null },
  ];
  assert.deepEqual(upcoming(events, NOW, 7).map((e) => e.summary), ["a", "b"]);
  assert.deepEqual(upcoming([...events].reverse(), NOW, 7).map((e) => e.summary), ["a", "b"]);
});

test("the window does not mutate the list it was given", () => {
  const events = readEvents(FEED);
  const order = events.map((e) => e.uid);
  upcoming(events, Date.UTC(2026, 8, 15), 7);
  assert.deepEqual(events.map((e) => e.uid), order);
});

test("a window of nothing sensible is a week rather than nothing at all", () => {
  // Zero days is an empty widget, and "days": "seven" in a config would produce one and
  // look like a calendar with nothing in it.
  for (const v of [undefined, null, 0, -3, NaN, "seven", {}, []]) {
    assert.equal(windowDays(v), DEFAULT_DAYS, JSON.stringify(v));
  }
  assert.equal(DEFAULT_DAYS, 7);
});

test("a quoted number of days is a number of days", () => {
  assert.equal(windowDays("14"), 14);
  assert.equal(windowDays(1.5), 1.5);
});

test("a window against nothing is empty rather than a throw", () => {
  for (const v of [null, undefined, "nope", 42, {}]) assert.deepEqual(upcoming(v, NOW, 7), [], String(v));
  assert.deepEqual(upcoming(readEvents(FEED), "now", 7), []);
});

// -- which feed --------------------------------------------------------------------------

test("a URL is a feed", () => {
  const s = readSource({ url: "https://example.com/basic.ics" });
  assert.equal(s.kind, "url");
  assert.equal(s.value, "https://example.com/basic.ics");
  assert.equal(s.source, "url:https://example.com/basic.ics");
});

test("webcal is rewritten to https, because that is what a calendar app hands you", () => {
  // And it is rewritten as text, because the URL protocol setter refuses to move from a
  // non-special scheme to a special one and does it by doing nothing at all.
  const s = readSource({ url: "webcal://example.com/basic.ics" });
  assert.equal(s.kind, "url");
  assert.equal(s.value, "https://example.com/basic.ics");
  assert.equal(readSource({ url: "WEBCAL://example.com/x.ics" }).value, "https://example.com/x.ics");
});

test("http is refused, and says why", () => {
  // The subscription URL is the credential for the calendar. http would put a token that
  // reads every appointment onto the wire in clear, on every poll, forever.
  const s = readSource({ url: "http://example.com/basic.ics" });
  assert.ok(s.error);
  assert.match(s.error, /https/);
  assert.equal(s.kind, undefined);
});

test("a scheme that is not a feed is refused", () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/x.ics", "javascript:alert(1)"]) {
    assert.ok(readSource({ url }).error, url);
  }
});

test("something that is not a URL is refused by name", () => {
  const s = readSource({ url: "not a url" });
  assert.match(s.error, /not a URL/);
});

test("a file path is a feed", () => {
  const s = readSource({ file: "/home/me/work.ics" });
  assert.equal(s.kind, "file");
  assert.equal(s.value, "/home/me/work.ics");
  assert.equal(s.source, "file:/home/me/work.ics");
});

test("both a URL and a file is a mistake to report, not one to pick between", () => {
  // Picking one silently means the user edits the other and nothing changes: a setting that
  // looks like it worked, which is the worst way for a setting to be wrong.
  const s = readSource({ url: "https://example.com/x.ics", file: "/x.ics" });
  assert.ok(s.error);
  assert.match(s.error, /keep one/);
});

test("nothing set says what to set, and goes on saying it", () => {
  for (const config of [undefined, null, {}, { url: "" }, { file: "  " }, { url: 42 }, { days: 7 }]) {
    const s = readSource(config);
    assert.match(s.error, /"url" or "file".*config\.json/, JSON.stringify(config));
  }
});

test("two different feeds are two different cache keys", () => {
  // A kept feed is only ever about the calendar it came from. Forgetting that is how a
  // widget shows last week's meetings from a URL the config no longer names.
  const a = readSource({ url: "https://example.com/a.ics" });
  const b = readSource({ url: "https://example.com/b.ics" });
  assert.notEqual(a.source, b.source);
  assert.notEqual(readSource({ file: "/a.ics" }).source, a.source);
});

// -- freshness ---------------------------------------------------------------------------

test("a read is fresh, then stale, then expired", () => {
  assert.equal(freshness(NOW, NOW), "fresh");
  assert.equal(freshness(NOW - FRESH_MS, NOW), "fresh");
  assert.equal(freshness(NOW - FRESH_MS - 1, NOW), "stale");
  assert.equal(freshness(NOW - STALE_MS, NOW), "stale");
  assert.equal(freshness(NOW - STALE_MS - 1, NOW), "expired");
});

test("the windows are what they are, and a day is the outer one", () => {
  // Written out longhand. The risk is these drifting upward until a three-day-old feed
  // counts as current, and a test that read the constant would drift with it. A calendar
  // gets a much longer life than a temperature because its events are dated; what expires
  // is the claim that the list is complete.
  assert.equal(FRESH_MS, 60 * 60 * 1000);
  assert.equal(STALE_MS, 24 * 60 * 60 * 1000);
});

test("a read from the future is expired, not fresh", () => {
  assert.equal(freshness(NOW + 60_000, NOW), "expired");
});

test("nothing sensible in means expired rather than a throw", () => {
  for (const v of [undefined, null, NaN, "yesterday"]) assert.equal(freshness(v, NOW), "expired", String(v));
});

test("a fresh read is available, with its events", () => {
  const events = upcoming(readEvents(FEED), NOW, 7);
  const p = present({ takenAt: NOW, source: "url:x", events, total: 4, days: 7 }, NOW);
  assert.equal(p.available, true);
  assert.equal(p.freshness, "fresh");
  assert.equal(p.events.length, 4);
});

test("a stale read is still shown, and says it is stale", () => {
  const p = present({ takenAt: NOW - FRESH_MS - 1000, events: [], total: 0, days: 7 }, NOW);
  assert.equal(p.available, true);
  assert.equal(p.freshness, "stale");
});

test("an expired read shows no events at all, and the reason", () => {
  // A day-old calendar cannot know about a cancellation, so the list is no longer a claim
  // worth making and the widget says so rather than showing a meeting that may be off.
  const p = present({ takenAt: NOW - STALE_MS - 1000, events: [{ summary: "x" }], total: 1 }, NOW);
  assert.equal(p.available, false);
  assert.equal(p.events, undefined);
  assert.match(p.reason, /too old/);
});

test("no read at all is unavailable with a reason, and no empty list to mistake for one", () => {
  // An empty events array here would render as "nothing coming up", which is a claim about
  // the calendar rather than an admission about the widget.
  const p = present(null, NOW);
  assert.equal(p.available, false);
  assert.equal(p.events, undefined);
  assert.ok(p.reason);
});

test("an error beats a staleness message, because the cause is more use than the symptom", () => {
  const p = present({ takenAt: NOW - STALE_MS - 1000, events: [] }, NOW, "getaddrinfo ENOTFOUND");
  assert.match(p.reason, /ENOTFOUND/);
});

test("a failed refresh keeps the last good read and reports the error beside it", () => {
  // One failed poll must not blank a widget that has a perfectly good answer.
  const p = present({ takenAt: NOW, source: "url:x", events: [], total: 3, days: 7 }, NOW, "timeout");
  assert.equal(p.available, true);
  assert.equal(p.total, 3);
  assert.match(p.reason, /timeout/);
});

test("an empty feed and a clear week are told apart", () => {
  // They render as the same empty list and they mean opposite things: one is a calendar to
  // fix, the other is a week with nothing in it.
  const empty = present({ takenAt: NOW, events: [], total: 0, days: 7 }, NOW);
  const clear = present({ takenAt: NOW, events: [], total: 12, days: 7 }, NOW);
  assert.equal(empty.total, 0);
  assert.equal(clear.total, 12);
  assert.equal(empty.available, true);
  assert.equal(clear.available, true);
});
