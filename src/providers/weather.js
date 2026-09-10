/**
 * The forecast, from a service that needs no key and no signup.
 *
 * [Open-Meteo](https://open-meteo.com) was chosen for one reason above the others: **there
 * is nothing to configure but a location.** No key to obtain, no account, no secret that
 * ends up in a tracked file by accident. Every other weather API in reach fails that test,
 * and a widget whose setup instructions begin "register for an API key" is a widget nobody
 * turns on.
 *
 * This file does the fetch and the caching and nothing else. Building the request, naming a
 * weather code, and deciding whether a reading is still worth showing are all in
 * `src/lib/weather.js`, where they are tested without a network.
 *
 * The fetch happens in the main process, so there is no CORS question at all. Open-Meteo
 * does send `Access-Control-Allow-Origin: *`, which is what makes the browser preview
 * possible, but nothing here depends on that.
 */
const {
  forecastRequest,
  geocodeRequest,
  readForecast,
  readPlace,
  present,
  sameLocation,
} = require("../lib/weather");

/** Fifteen minutes. The service updates hourly, so anything faster is spending someone
 *  else's quota to redraw the same number. */
const INTERVAL_MS = 15 * 60 * 1000;

/** Enough to fail rather than hang. A widget that never resolves shows nothing forever. */
const TIMEOUT_MS = 8000;

/**
 * The last good reading, kept across polls.
 *
 * This is what makes a network drop degrade rather than blank. `present()` decides how long
 * it stays worth showing, and the widget is told which state it is in.
 */
let last = null;
let lastError = null;

/** Resolved coordinates for a place name, so the lookup happens once and not every poll. */
let resolved = null;
let resolvedFor = null;

async function getJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Coordinates for this config, looking a place name up if that is all there is.
 *
 * Cached against the name it was resolved for, so changing the name in the config
 * re-resolves and leaving it alone does not.
 */
async function coordinates(config) {
  if (Number.isFinite(Number(config?.latitude)) && Number.isFinite(Number(config?.longitude))) {
    return { latitude: Number(config.latitude), longitude: Number(config.longitude) };
  }

  const place = typeof config?.place === "string" ? config.place.trim() : "";
  if (place === "") return null;
  if (resolvedFor === place && resolved) return resolved;

  const req = geocodeRequest(place);
  if (req.error) throw new Error(req.error);
  const found = readPlace(await getJson(req.url));
  // An unknown name is a 200 with no results. That is a configuration mistake, not a
  // network failure, and it has to read as one.
  if (!found) throw new Error(`no place called "${place}"`);
  resolved = found;
  resolvedFor = place;
  return found;
}

const weather = {
  name: "weather",
  intervalMs: INTERVAL_MS,
  /**
   * No default location, deliberately. A default would put somebody else's weather on your
   * desktop and look like it had worked, which is the worst way for a setting to be wrong.
   */
  defaults: { units: "metric" },
  async read(config) {
    const now = Date.now();

    let where;
    try {
      where = await coordinates(config);
    } catch (e) {
      // The location itself could not be worked out, so nothing in the cache is about the
      // place being asked for. Presenting it here is what showed one city's weather under
      // another city's name.
      last = null;
      lastError = e.message ?? String(e);
      return present(null, now, lastError);
    }

    if (!where) {
      last = null;
      // Not an error to retry. The widget should say what to set, and go on saying it.
      return present(null, now, 'set "latitude" and "longitude", or "place", under providers.weather in ~/.hikari/config.json');
    }

    // The location moved, so the kept reading is about somewhere else.
    if (last && !sameLocation(last, where)) last = null;

    const req = forecastRequest({ ...config, ...where });
    if (req.error) {
      last = null;
      return present(null, now, req.error);
    }

    try {
      const body = await getJson(req.url);
      last = readForecast(body, Date.now());
      lastError = null;
      return present(last, Date.now(), null);
    } catch (e) {
      // Only here is the cache still valid: the location resolved, and the request for
      // *that* location failed. Kept rather than thrown, because the host stores nothing
      // for a provider that throws and one failed poll would blank the widget.
      lastError = e.message ?? String(e);
      return present(last, now, lastError);
    }
  },
};

module.exports = { weather, INTERVAL_MS, TIMEOUT_MS };
