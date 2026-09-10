const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  CODES,
  KNOWN_CODES,
  FRESH_MS,
  STALE_MS,
  conditionFor,
  freshness,
  forecastRequest,
  geocodeRequest,
  readPlace,
  readForecast,
  present,
  sameLocation,
} = require("../src/lib/weather");

/** A real response, captured from the API rather than invented, so the shape is the shape. */
const REAL = {
  latitude: 51.51147,
  longitude: -0.13078308,
  utc_offset_seconds: 3600,
  timezone: "Europe/London",
  current_units: { temperature_2m: "°C", wind_speed_10m: "km/h" },
  current: {
    time: "2026-09-10T19:00",
    interval: 900,
    temperature_2m: 18.7,
    relative_humidity_2m: 59,
    apparent_temperature: 16.4,
    is_day: 1,
    weather_code: 3,
    wind_speed_10m: 16.9,
  },
  daily_units: { temperature_2m_max: "°C" },
  daily: {
    time: ["2026-09-10", "2026-09-11"],
    weather_code: [51, 53],
    temperature_2m_max: [20.3, 21.8],
    temperature_2m_min: [14.0, 16.3],
  },
};

const NOW = Date.UTC(2026, 8, 10, 19, 5);

test("every WMO code Open-Meteo documents has a word", () => {
  // Transcribed from Open-Meteo's own table. A missing code renders as unknown for a real
  // condition, and 2am on a snowy night is when a widget saying "unknown" is least useful.
  const documented = [
    0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82,
    85, 86, 95, 96, 99,
  ];
  for (const code of documented) {
    assert.ok(conditionFor(code), `code ${code} has no word`);
  }
  assert.deepEqual(KNOWN_CODES.sort((a, b) => a - b), documented);
});

test("an undocumented code is unknown rather than given a made-up word", () => {
  for (const code of [4, 20, 100, -1, 1000]) assert.equal(conditionFor(code), null, String(code));
});

test("a code that is not an integer is unknown, not coerced", () => {
  for (const v of [undefined, null, "3", 3.5, NaN, {}]) assert.equal(conditionFor(v), null, String(v));
});

test("the table has no empty words in it", () => {
  for (const [code, word] of Object.entries(CODES)) {
    assert.ok(word.trim().length > 2, `code ${code} has a useless word`);
  }
});

test("a reading is fresh, then stale, then expired", () => {
  assert.equal(freshness(NOW, NOW), "fresh");
  assert.equal(freshness(NOW - FRESH_MS, NOW), "fresh");
  assert.equal(freshness(NOW - FRESH_MS - 1, NOW), "stale");
  assert.equal(freshness(NOW - STALE_MS, NOW), "stale");
  assert.equal(freshness(NOW - STALE_MS - 1, NOW), "expired");
});

test("the freshness windows are what they are", () => {
  // Written out longhand. The risk is these drifting upward until a four-hour-old reading
  // counts as current, and a test that reads the constant would drift with it.
  assert.equal(FRESH_MS, 60 * 60 * 1000);
  assert.equal(STALE_MS, 3 * 60 * 60 * 1000);
});

test("a reading from the future is expired, not fresh", () => {
  // A clock problem, not a good reading. Treating it as fresh would put a number on screen
  // that nobody can account for.
  assert.equal(freshness(NOW + 60_000, NOW), "expired");
});

test("nothing sensible in means expired rather than a throw", () => {
  for (const v of [undefined, null, NaN, "yesterday"]) assert.equal(freshness(v, NOW), "expired", String(v));
});

test("a request needs real coordinates and refuses to invent them", () => {
  // A default location would put somebody else's weather on your desktop and look like it
  // worked, which is the worst way for a setting to be wrong.
  const r = forecastRequest({});
  assert.ok(r.error);
  assert.match(r.error, /latitude.*longitude.*config\.json/);
});

test("coordinates outside the world are refused, naming the one that is wrong", () => {
  assert.match(forecastRequest({ latitude: 91, longitude: 0 }).error, /latitude 91/);
  assert.match(forecastRequest({ latitude: 0, longitude: -181 }).error, /longitude -181/);
});

test("a valid request asks for the fields the widget reads and nothing else", () => {
  const { url } = forecastRequest({ latitude: 51.5074, longitude: -0.1278 });
  const q = new URL(url).searchParams;
  assert.equal(q.get("latitude"), "51.5074");
  assert.equal(q.get("timezone"), "auto");
  for (const field of ["temperature_2m", "weather_code", "is_day", "apparent_temperature"]) {
    assert.ok(q.get("current").includes(field), `current is missing ${field}`);
  }
  // No key, and nothing that looks like one. The whole reason this service was chosen.
  assert.equal(q.get("apikey"), null);
  assert.ok(!url.includes("key="), "the URL carries something that looks like a key");
});

test("imperial changes the units rather than converting after the fact", () => {
  // Asking the service for Fahrenheit means one number and one source of rounding. A
  // conversion here would be a second place for the value to be wrong.
  const { url } = forecastRequest({ latitude: 40.7, longitude: -74, units: "imperial" });
  const q = new URL(url).searchParams;
  assert.equal(q.get("temperature_unit"), "fahrenheit");
  assert.equal(q.get("wind_speed_unit"), "mph");
});

test("an unknown units value falls back to metric rather than being passed through", () => {
  const { url } = forecastRequest({ latitude: 0, longitude: 0, units: "kelvin" });
  assert.equal(new URL(url).searchParams.get("temperature_unit"), null);
});

test("a real response reads into the shape a widget uses", () => {
  const r = readForecast(REAL, NOW);
  assert.equal(r.temperature, 18.7);
  assert.equal(r.feelsLike, 16.4);
  assert.equal(r.humidity, 59);
  assert.equal(r.windSpeed, 16.9);
  assert.equal(r.isDay, true);
  assert.equal(r.code, 3);
  assert.equal(r.condition, "overcast");
  assert.equal(r.high, 20.3);
  assert.equal(r.low, 14.0);
  assert.equal(r.timezone, "Europe/London");
  assert.equal(r.units, "metric");
});

test("a missing field is null and costs the others nothing", () => {
  // One absent value must not blank the widget, which is what a single availability flag
  // would do.
  const r = readForecast({ current: { temperature_2m: 18.7 } }, NOW);
  assert.equal(r.temperature, 18.7);
  assert.equal(r.humidity, null);
  assert.equal(r.condition, null);
  assert.equal(r.high, null);
});

test("is_day absent stays unknown rather than becoming night", () => {
  assert.equal(readForecast({ current: {} }, NOW).isDay, null);
  assert.equal(readForecast({ current: { is_day: 0 } }, NOW).isDay, false);
  assert.equal(readForecast({ current: { is_day: 1 } }, NOW).isDay, true);
});

test("a zero temperature is a temperature, not a missing value", () => {
  // The one place a falsy check would be a real bug: 0 degrees is a reading.
  assert.equal(readForecast({ current: { temperature_2m: 0 } }, NOW).temperature, 0);
});

test("garbage in reads as all nulls rather than throwing", () => {
  for (const body of [null, undefined, {}, { current: null }, "nope", 42]) {
    const r = readForecast(body, NOW);
    assert.equal(r.temperature, null, JSON.stringify(body));
  }
});

test("a place name becomes a lookup, and an empty one does not", () => {
  assert.match(geocodeRequest("London").url, /name=London/);
  assert.ok(geocodeRequest("").error);
  assert.ok(geocodeRequest(null).error);
  assert.ok(geocodeRequest("   ").error);
});

test("a geocoding result reads into coordinates", () => {
  const p = readPlace({ results: [{ name: "London", country: "United Kingdom", latitude: 51.5, longitude: -0.12 }] });
  assert.deepEqual(p, { name: "London", country: "United Kingdom", latitude: 51.5, longitude: -0.12 });
});

test("no such place is null, which is not the same as a failed lookup", () => {
  // Open-Meteo omits `results` entirely for an unknown name, and it is a 200. "No such
  // place" and "the lookup failed" need different messages.
  assert.equal(readPlace({}), null);
  assert.equal(readPlace({ results: [] }), null);
  assert.equal(readPlace({ results: [{ name: "x" }] }), null);
});

test("a fresh reading is available", () => {
  const p = present(readForecast(REAL, NOW), NOW);
  assert.equal(p.available, true);
  assert.equal(p.freshness, "fresh");
  assert.equal(p.temperature, 18.7);
});

test("a stale reading is still shown, and says it is stale", () => {
  const p = present(readForecast(REAL, NOW - FRESH_MS - 1000), NOW);
  assert.equal(p.available, true);
  assert.equal(p.freshness, "stale");
});

test("an expired reading is unavailable, with the reason, and no number", () => {
  // The promise in the README: cut the network and it says it does not know, rather than
  // showing four hours ago as though it were now.
  const p = present(readForecast(REAL, NOW - STALE_MS - 1000), NOW);
  assert.equal(p.available, false);
  assert.equal(p.temperature, undefined);
  assert.match(p.reason, /too old/);
});

test("no reading at all is unavailable with a reason, never zero", () => {
  const p = present(null, NOW);
  assert.equal(p.available, false);
  assert.equal(p.temperature, undefined);
  assert.ok(p.reason);
});

test("an error beats a staleness message, because the cause is more use than the symptom", () => {
  const p = present(readForecast(REAL, NOW - STALE_MS - 1000), NOW, "getaddrinfo ENOTFOUND");
  assert.equal(p.available, false);
  assert.match(p.reason, /ENOTFOUND/);
});

test("an error alongside a fresh reading keeps the reading and mentions the error", () => {
  // A refresh failing does not make the last reading wrong, and hiding a good number
  // because the next request failed would be worse than saying both.
  const p = present(readForecast(REAL, NOW), NOW, "timeout");
  assert.equal(p.available, true);
  assert.equal(p.temperature, 18.7);
  assert.match(p.reason, /timeout/);
});

test("a value that coerces to zero is null, because Number(null) is 0", () => {
  // The one that actually bit. `num` checked Number.isFinite without checking the type, so
  // a missing daily high read as zero degrees: null, "", " " and [] all coerce to 0.
  for (const v of [null, undefined, "", " ", [], {}, "18.7", true, false]) {
    const r = readForecast({ current: { temperature_2m: v } }, NOW);
    assert.equal(r.temperature, null, JSON.stringify(v));
  }
});

test("a reading is only valid for the place it was taken", () => {
  // The worst bug this file had. Changing `place` to something unresolvable left the old
  // reading in the cache, and the widget showed Reykjavik's temperature, marked fresh, next
  // to the words "no place called ...". A real, recent number about somewhere else.
  const london = { latitude: 51.5074, longitude: -0.1278 };
  const reykjavik = { latitude: 64.1466, longitude: -21.9426 };
  assert.equal(sameLocation(london, london), true);
  assert.equal(sameLocation(london, reykjavik), false);
});

test("coordinates matching to about a hundred metres count as the same place", () => {
  // A geocoding result carries more decimal places than a config does, and an exact float
  // comparison would re-fetch on every poll for a location that has not moved.
  assert.equal(sameLocation({ latitude: 51.5074, longitude: -0.1278 },
                            { latitude: 51.50741, longitude: -0.12781 }), true);
  assert.equal(sameLocation({ latitude: 51.5074, longitude: -0.1278 },
                            { latitude: 51.52, longitude: -0.1278 }), false);
});

test("a location that is not a location is never the same as anything", () => {
  const real = { latitude: 51.5, longitude: -0.1 };
  for (const bad of [null, undefined, {}, { latitude: 51.5 }, { latitude: null, longitude: null }]) {
    assert.equal(sameLocation(real, bad), false, JSON.stringify(bad));
  }
});

test("two missing coordinates do not match a real reading at zero, zero", () => {
  // Number(null) is 0, and so is Number(""). A plain coercion would make any location that
  // failed to resolve equal to a genuine reading off the coast of Ghana, and the cache
  // would hand that reading over.
  const gulfOfGuinea = { latitude: 0, longitude: 0 };
  for (const bad of [{ latitude: null, longitude: null }, { latitude: "", longitude: "" }, {}]) {
    assert.equal(sameLocation(gulfOfGuinea, bad), false, JSON.stringify(bad));
  }
});

test("a quoted number in a config is the same place, not an unknown one", () => {
  // Otherwise a config written with quotes re-fetches on every poll for a location that
  // has not moved.
  assert.equal(sameLocation({ latitude: 51.5, longitude: -0.1 },
                            { latitude: "51.5", longitude: "-0.1" }), true);
});

test("a reading carries the coordinates it is about", () => {
  const r = readForecast(REAL, NOW);
  assert.equal(r.latitude, 51.51147);
  assert.equal(r.longitude, -0.13078308);
});
