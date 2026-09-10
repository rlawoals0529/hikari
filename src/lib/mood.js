/**
 * What the companion is doing, decided from provider output rather than from a timer.
 *
 * This is the whole widget. The drawing is a few ellipses; the part worth testing is the
 * mapping, because it is the part that can quietly start lying.
 */

/** Load at or above this is strain worth noticing across the room. */
const BUSY = 70;
/** And above this it is doing something, but nothing alarming. */
const WORKING = 30;
/** Hours when a machine being awake says more about you than about the machine. */
const LATE_FROM = 23, LATE_UNTIL = 5;

/**
 * Moods, most insistent first. The order is the design.
 *
 * `unknown` outranks everything because a companion that looks settled when it has no
 * reading is lying, and this is the one widget whose whole job is to be read at a glance.
 * `busy` comes next because strain is the thing worth interrupting you for. Music beats
 * the clock, since a machine playing something at 2am is listening rather than asleep.
 */
const MOODS = {
  unknown:   { energy: 0.30, eyes: "question", label: "no reading" },
  busy:      { energy: 1.00, eyes: "wide",     label: "working hard" },
  listening: { energy: 0.70, eyes: "happy",    label: "listening" },
  sleepy:    { energy: 0.12, eyes: "closed",   label: "asleep" },
  working:   { energy: 0.55, eyes: "open",     label: "busy" },
  idle:      { energy: 0.28, eyes: "open",     label: "idle" },
};

function isLate(hour) {
  if (!Number.isInteger(hour)) return false;
  return hour >= LATE_FROM || hour < LATE_UNTIL;
}

/**
 * Pick a mood. `hour` is passed in rather than read from the clock so the rule can be
 * tested at 3am without waiting until 3am.
 */
function moodFrom(state, hour) {
  const s = state || {};
  const usage = s.cpu ? s.cpu.usage : undefined;

  // Null is the provider saying it could not measure, which is not the same as zero and
  // must not be rendered as a calm machine.
  const known = typeof usage === "number" && Number.isFinite(usage);
  const name =
    !known ? "unknown"
    : usage >= BUSY ? "busy"
    : s.media && s.media.isPlaying ? "listening"
    : isLate(hour) ? "sleepy"
    : usage >= WORKING ? "working"
    : "idle";

  return { name, ...MOODS[name] };
}

/**
 * How far through a breath the character is, 0..1 and back, at a rate the mood sets.
 *
 * A single phase drives every moving part, so the ears, the tail and the body cannot
 * drift out of step with each other the way three separate timers would.
 */
function breath(elapsedMs, energy) {
  const e = Math.min(1, Math.max(0, Number(energy) || 0));
  // Slowest is a four second cycle, fastest is just under one.
  const period = 4000 - e * 3100;
  const t = ((Number(elapsedMs) || 0) % period) / period;
  return (1 - Math.cos(t * Math.PI * 2)) / 2;
}

/**
 * Whether the eyes are shut on this frame.
 *
 * Blinks are scheduled off a hash of the elapsed time rather than at random, so two
 * companions on one desktop do not blink in unison and a screenshot is reproducible.
 */
function blinking(elapsedMs, eyes) {
  if (eyes === "closed") return true;
  if (eyes === "question") return false;
  const t = Number(elapsedMs) || 0;
  const slot = Math.floor(t / 4200);
  const offset = (Math.sin(slot * 12.9898) * 43758.5453) % 1;
  const at = Math.abs(offset) * 3600;
  const into = t % 4200;
  return into >= at && into < at + 130;
}

const api = { moodFrom, breath, blinking, BUSY, WORKING, isLate };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.hikariMood = api;
