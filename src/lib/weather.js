/**
 * Reading a forecast, and knowing when to stop believing it.
 *
 * Everything here is pure: building the request, naming a weather code, converting units,
 * and deciding whether a reading is still worth showing. The provider does the fetch and
 * nothing else, which is what makes the interesting half testable without a network.
 *
 * The rule that shapes all of it is the one this repo already had: **a reading it cannot
 * take renders as unknown, never as zero.** For weather that goes further, because a stale
 * reading is worse than no reading. Fifteen degrees from four hours ago shown as though it
 * were current is a wrong answer with no way to tell it is wrong, so age travels with the
 * value and the widget is told when to stop trusting it.
 */

const { classify, present: presentReading } = require("./freshness");

/**
 * WMO weather interpretation codes, transcribed from Open-Meteo's own documentation.
 *
 * Exhaustive rather than a guess at the common ones. A missing code would render as
 * "unknown" for a real condition, and 2am on a snowy night is exactly when a widget saying
 * "unknown" is least useful.
 */
const CODES = {
  0: "clear",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "light freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "light snow showers",
  86: "snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

/**
 * A code as words, or null.
 *
 * Null rather than a fallback string, because "unknown condition" and a condition this
 * does not have a word for are the same thing to a reader and should look the same.
 */
function conditionFor(code) {
  if (!Number.isInteger(code)) return null;
  return CODES[code] ?? null;
}

/** Every code that has a word, for a test that the table is not silently half empty. */
const KNOWN_CODES = Object.keys(CODES).map(Number);

/**
 * How long a reading stays worth showing.
 *
 * Open-Meteo updates hourly and its `current` block carries a 15-minute interval, so an
 * hour is generous and two is the point past which the number is a guess. Beyond that the
 * widget says it does not know, which is the honest answer and the one the README promises.
 */
const FRESH_MS = 60 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;

/**
 * The windows and the wording, handed to the shared rule in `freshness.js`.
 *
 * The three-state age decision is not about weather, and the second provider to need it
 * would have made this file's copy one of two. Only these four values are weather's.
 */
const LIFE = {
  freshMs: FRESH_MS,
  staleMs: STALE_MS,
  missing: "no reading yet",
  tooOld: "the last reading is too old to show",
};

/**
 * @returns {"fresh" | "stale" | "expired"}
 */
function freshness(takenAt, now) {
  return classify(takenAt, now, LIFE);
}

const ALLOWED_UNITS = new Set(["metric", "imperial"]);

/**
 * The forecast request for a config.
 *
 * Latitude and longitude only. Resolving a city name is a second request to a second
 * endpoint and belongs in its own function, so this one cannot half-fail.
 *
 * @returns {{url: string} | {error: string}}
 */
function forecastRequest(config) {
  const lat = Number(config?.latitude);
  const lon = Number(config?.longitude);

  // Refused rather than defaulted. A default location would put somebody else's weather on
  // your desktop and look like it worked, which is the worst way for a setting to be wrong.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { error: 'set "latitude" and "longitude" in ~/.hikari/config.json under providers.weather' };
  }
  if (lat < -90 || lat > 90) return { error: `latitude ${lat} is outside -90 to 90` };
  if (lon < -180 || lon > 180) return { error: `longitude ${lon} is outside -180 to 180` };

  const units = ALLOWED_UNITS.has(config?.units) ? config.units : "metric";
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    forecast_days: "2",
    // Let the service resolve the zone from the coordinates. Sending our own would be
    // sending the machine's timezone, which is not necessarily the location's.
    timezone: "auto",
  });
  if (units === "imperial") {
    params.set("temperature_unit", "fahrenheit");
    params.set("wind_speed_unit", "mph");
  }
  return { url: `https://api.open-meteo.com/v1/forecast?${params}` };
}

/** The geocoding request for a city name, so a config can say "London" instead of numbers. */
function geocodeRequest(name) {
  if (typeof name !== "string" || name.trim() === "") return { error: "no place name to look up" };
  const params = new URLSearchParams({ name: name.trim(), count: "1", format: "json" });
  return { url: `https://geocoding-api.open-meteo.com/v1/search?${params}` };
}

/**
 * A place out of a geocoding response, or null.
 *
 * Null for an empty result set, which is what an unknown place name produces. It is not an
 * error in the HTTP sense and it must not be reported as one: "no such place" and "the
 * lookup failed" need different messages.
 */
function readPlace(body) {
  const first = Array.isArray(body?.results) ? body.results[0] : null;
  if (!first) return null;
  const lat = Number(first.latitude);
  const lon = Number(first.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    name: typeof first.name === "string" ? first.name : null,
    country: typeof first.country === "string" ? first.country : null,
    latitude: lat,
    longitude: lon,
  };
}

/**
 * A number from the response, or null. Never a fallback.
 *
 * The type check comes first, and it has to: `Number(null)` is 0, and so is `Number("")`
 * and `Number([])`. A helper that only asked `Number.isFinite` reported a missing daily
 * high as zero degrees, which is this repo's one rule broken in the one place it matters
 * most. Caught by a test asserting a missing field is null.
 */
function num(v) {
  if (typeof v !== "number") return null;
  return Number.isFinite(v) ? v : null;
}

/**
 * A forecast response as the shape a widget reads.
 *
 * Every field is independently nullable, because a response missing one value must not cost
 * the others. The alternative is a single `available` flag, and that turns one absent field
 * into a blank widget.
 *
 * @param {object} body   the parsed response
 * @param {number} takenAt  when the request completed
 */
function readForecast(body, takenAt) {
  const current = body?.current ?? {};
  const daily = body?.daily ?? {};

  const code = Number.isInteger(current.weather_code) ? current.weather_code : null;

  return {
    takenAt: Number.isFinite(takenAt) ? takenAt : null,
    // The location this reading is about, carried with it. A reading is only ever valid for
    // where it was taken, and the cache has to be able to check that.
    latitude: num(body?.latitude),
    longitude: num(body?.longitude),
    temperature: num(current.temperature_2m),
    feelsLike: num(current.apparent_temperature),
    humidity: num(current.relative_humidity_2m),
    windSpeed: num(current.wind_speed_10m),
    // 1 and 0 rather than truthiness: `is_day` is absent on some responses, and absent has
    // to stay unknown rather than becoming night.
    isDay: current.is_day === 1 ? true : current.is_day === 0 ? false : null,
    code,
    condition: conditionFor(code),
    high: num(Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null),
    low: num(Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null),
    units: body?.current_units?.temperature_2m === "°F" ? "imperial" : "metric",
    timezone: typeof body?.timezone === "string" ? body.timezone : null,
  };
}

/**
 * Whether a kept reading is still about the place being asked for.
 *
 * A cached reading is only ever valid for the location it was taken at, and forgetting that
 * produced the worst bug in this file. Changing `place` in the config to something that
 * cannot be resolved left the previous reading in the cache, and the widget showed
 * Reykjavik's temperature, marked fresh, next to the words "no place called ...". The number
 * was real, recent, and about somewhere else entirely, which is exactly the failure the
 * staleness rules exist to prevent, wearing a different hat.
 *
 * Coordinates are compared to about 100 metres. A forecast does not change over that
 * distance, and comparing floats exactly would re-fetch every poll because a geocoding
 * result carries more decimal places than a config does.
 */
function sameLocation(a, b) {
  if (!a || !b) return false;
  const coords = [a.latitude, a.longitude, b.latitude, b.longitude].map(coord);
  if (coords.some((c) => c === null)) return false;
  const [lat, lon, lat2, lon2] = coords;
  return Math.abs(lat - lat2) < 0.001 && Math.abs(lon - lon2) < 0.001;
}

/**
 * A coordinate, coerced but not invented.
 *
 * A numeric string is accepted, because `"latitude": "51.5"` in a config is a quoted number
 * and treating it as unknown would re-fetch on every poll for a location that has not
 * moved. Absence is not: `Number(null)` and `Number("")` are both 0, so a plain coercion
 * would make two missing coordinates equal to a real reading at 0, 0 off the coast of
 * Ghana, and the cache would hand that reading to any location that failed to resolve.
 */
function coord(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" && typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * What to hand the widget, given the last reading and the time.
 *
 * This is where the promise is kept. A reading past its life renders as unknown with the
 * reason attached, rather than as a number that looks current.
 */
function present(reading, now, error) {
  return presentReading(reading, now, error, LIFE);
}

module.exports = {
  CODES,
  KNOWN_CODES,
  FRESH_MS,
  STALE_MS,
  conditionFor,
  freshness,
  sameLocation,
  forecastRequest,
  geocodeRequest,
  readPlace,
  readForecast,
  present,
};
