/**
 * How long a reading stays worth showing, and what to hand a widget once it is not.
 *
 * This started as two functions inside `weather.js`, and the second provider that needed a
 * staleness rule would have made them two copies of one decision. The decision itself is
 * not about weather: **a value it cannot take renders as unknown, never as zero, and a
 * value too old to trust renders as unknown rather than as a value.** Only the windows and
 * the wording differ per provider, so those are arguments and the rule is here once.
 *
 * A `life` is `{ freshMs, staleMs, missing, tooOld }`. The two messages travel with the
 * windows because a widget shows them verbatim, and "the last reading is too old" is the
 * wrong sentence about a calendar in the same way "the last feed" is the wrong sentence
 * about a thermometer.
 */

/**
 * @returns {"fresh" | "stale" | "expired"}
 */
function classify(takenAt, now, life) {
  if (!Number.isFinite(takenAt) || !Number.isFinite(now)) return "expired";
  const age = now - takenAt;
  // A reading from the future is a clock problem, not a fresh reading, and treating it as
  // fresh would show a value nobody can account for.
  if (age < 0) return "expired";
  if (age <= life.freshMs) return "fresh";
  if (age <= life.staleMs) return "stale";
  return "expired";
}

/**
 * What to hand the widget, given the last reading, the time, and the last error.
 *
 * Three outcomes, and the middle one is the whole point: a reading past its life becomes
 * unknown with the reason attached rather than a value that looks current, while a reading
 * merely old is still shown and told to say so.
 */
function present(reading, now, error, life) {
  if (!reading) {
    return { available: false, reason: error ?? life.missing, freshness: "expired" };
  }
  const state = classify(reading.takenAt, now, life);
  if (state === "expired") {
    return {
      // The last error if there was one, because "the network is down" is more use than
      // "this is old" when both are true.
      available: false,
      reason: error ?? life.tooOld,
      freshness: state,
      takenAt: reading.takenAt,
    };
  }
  return { ...reading, available: true, freshness: state, ...(error ? { reason: error } : {}) };
}

module.exports = { classify, present };
