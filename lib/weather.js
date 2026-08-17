// Open-Meteo historical archive wrapper + daily aggregation.
// https://open-meteo.com/en/docs/historical-weather-api

import * as cache from './cache.js';

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/**
 * Which reanalysis to ask Open-Meteo for. This is a genuine trade-off between
 * accuracy in any single year and comparability across years, so it's a user
 * choice rather than a hard-coded one.
 *
 * `best_match` (Open-Meteo's default) blends in IFS HRES at 9 km from 2017 onward.
 * A finer grid resolves terrain that a 25 km cell averages away, so it is the more
 * accurate answer to "what happened here in 2023". But the resolution changes
 * mid-window, and finer grids resolve local extremes that coarser ones smooth out,
 * so post-2017 values read systematically higher at the same real weather. Part of
 * any 10-vs-30-year difference is then the model, not the climate.
 *
 * The `era5*` options hold one resolution across the whole window, trading
 * per-year accuracy for a like-for-like comparison over time.
 */
export const MODELS = [
  {
    id: 'best_match',
    label: 'Best match — highest resolution per year',
    note: 'IFS HRES (~9 km) from 2017, ERA5/ERA5-Land before. Most accurate per year; ' +
      'the resolution change at 2017 can look like a trend when comparing windows.',
    homogeneous: false,
  },
  {
    id: 'era5_seamless',
    label: 'ERA5 seamless — consistent across years',
    note: 'Temperature, humidity and soil from ERA5-Land (~11 km, 1950-); wind, ' +
      'precipitation and radiation from ERA5 (~25 km, 1940-). Same resolution every year.',
    homogeneous: true,
  },
  {
    id: 'era5',
    label: 'ERA5 only — uniform ~25 km',
    note: 'Every variable from ERA5 at ~25 km, 1940 onward. The most uniform option.',
    homogeneous: true,
  },
];

export const DEFAULT_MODEL = 'best_match';

export function getModel(id) {
  return MODELS.find((m) => m.id === id) || MODELS[0];
}

// ERA5 starts in 1940 and trails real time by roughly five days.
const EARLIEST_YEAR = 1940;
const ARCHIVE_LAG_DAYS = 6;

// A day is only counted once most of its hours are present, so a partially
// reported day can't masquerade as a low daily max or a small daily total.
const MIN_HOURS_PER_DAY = 20;

// Sequential requests would take ~30s for a 30-year window; four at a time keeps it
// quick without tripping Open-Meteo's rate limiter.
const CONCURRENCY = 4;

// Open-Meteo does not bill one HTTP request as one API call. A request is weighted by
// how much it asks for: more than 10 variables, or more than 2 weeks of data, counts
// as a fraction more. Their example — 2 weeks x 15 variables = 1.5 calls, 4 weeks x
// 15 variables = 3.0 — gives the shape below.
//
// Two consequences drive the request strategy:
//   1. Up to 10 variables ride along in one request for free, so asking for every
//      selected variable at once costs the same as asking for one.
//   2. The day factor is proportional, so merging years into a single continuous
//      range saves nothing on quota and downloads far more for a narrow window.
//      One request per year, all variables batched, is the cheap shape.
const FREE_VARIABLES_PER_CALL = 10;
const FREE_DAYS_PER_CALL = 14;

/** Weighted API calls for one request covering `days` days and `variables` variables. */
export function callWeight(variables, days) {
  return (
    Math.max(1, variables / FREE_VARIABLES_PER_CALL) * Math.max(1, days / FREE_DAYS_PER_CALL)
  );
}

/**
 * Weighted calls a cold fetch of this query would cost — one request per year, every
 * variable batched into it.
 */
export function estimateCalls({ years, startMD, endMD, variableCount }) {
  return years.reduce(
    (total, year) => total + callWeight(variableCount, daysInWindow(year, startMD, endMD)),
    0
  );
}

// The finest model behind this app is ERA5-Land at 0.1 degrees (~11 km), and ERA5
// itself is 0.25 degrees (~25 km). Snapping the request to ~1 km therefore cannot
// change which grid cell answers it, and it means two searches for the same town
// that differ by a few hundred metres share one cache entry instead of two.
const COORD_DECIMALS = 2;

export function snapCoord(value) {
  return Number(Number(value).toFixed(COORD_DECIMALS));
}

export class WeatherError extends Error {}

/**
 * Every continuous hourly variable the archive serves for the full lookback range,
 * paired with the daily aggregation that makes sense for it. `unit` is only a
 * fallback label — the real unit is read from the response's `hourly_units` so a
 * unit-parameter change can't silently mislabel an axis. `scale` converts the
 * aggregated value (and then the declared unit wins, since the API's no longer
 * applies).
 *
 * Deliberately excluded, because a histogram of them would mislead rather than
 * inform:
 *   - `wind_direction_10m` / `_100m` — circular degrees. Averaging 350° and 10°
 *     gives 180°, the opposite direction. Direction needs a wind rose, which the
 *     spec lists as a v1 non-goal.
 *   - `weather_code` — a categorical WMO code; the numeric spacing is meaningless.
 *   - `global_tilted_irradiance` — requires panel tilt/azimuth parameters.
 *   - ensemble spread variables — need `models=era5_ensemble`.
 */
export const VARIABLES = [
  // Temperature and humidity
  { id: 'temp_max', group: 'Temperature & humidity', label: 'Max temperature (2 m)', short: 'Max temperature', hourly: 'temperature_2m', agg: 'max', unit: '°F', decimals: 1 },
  { id: 'temp_min', group: 'Temperature & humidity', label: 'Min temperature (2 m)', short: 'Min temperature', hourly: 'temperature_2m', agg: 'min', unit: '°F', decimals: 1 },
  { id: 'temp_mean', group: 'Temperature & humidity', label: 'Mean temperature (2 m)', short: 'Mean temperature', hourly: 'temperature_2m', agg: 'mean', unit: '°F', decimals: 1 },
  { id: 'apparent_max', group: 'Temperature & humidity', label: 'Max apparent temperature', short: 'Max apparent temp', hourly: 'apparent_temperature', agg: 'max', unit: '°F', decimals: 1 },
  { id: 'apparent_min', group: 'Temperature & humidity', label: 'Min apparent temperature', short: 'Min apparent temp', hourly: 'apparent_temperature', agg: 'min', unit: '°F', decimals: 1 },
  { id: 'dewpoint_max', group: 'Temperature & humidity', label: 'Max dew point (2 m)', short: 'Max dew point', hourly: 'dew_point_2m', agg: 'max', unit: '°F', decimals: 1 },
  { id: 'dewpoint_mean', group: 'Temperature & humidity', label: 'Mean dew point (2 m)', short: 'Mean dew point', hourly: 'dew_point_2m', agg: 'mean', unit: '°F', decimals: 1 },
  { id: 'humidity_mean', group: 'Temperature & humidity', label: 'Mean relative humidity (2 m)', short: 'Mean relative humidity', hourly: 'relative_humidity_2m', agg: 'mean', unit: '%', decimals: 1 },
  { id: 'humidity_min', group: 'Temperature & humidity', label: 'Min relative humidity (2 m)', short: 'Min relative humidity', hourly: 'relative_humidity_2m', agg: 'min', unit: '%', decimals: 1 },
  { id: 'vpd_max', group: 'Temperature & humidity', label: 'Max vapour pressure deficit', short: 'Max VPD', hourly: 'vapour_pressure_deficit', agg: 'max', unit: 'kPa', decimals: 2 },
  { id: 'vpd_mean', group: 'Temperature & humidity', label: 'Mean vapour pressure deficit', short: 'Mean VPD', hourly: 'vapour_pressure_deficit', agg: 'mean', unit: 'kPa', decimals: 2 },

  // Wind
  { id: 'wind_gust_max', group: 'Wind', label: 'Max wind gust (10 m)', short: 'Max wind gust', hourly: 'wind_gusts_10m', agg: 'max', unit: 'mph', decimals: 1 },
  { id: 'wind_speed_max', group: 'Wind', label: 'Max wind speed (10 m)', short: 'Max wind speed', hourly: 'wind_speed_10m', agg: 'max', unit: 'mph', decimals: 1 },
  { id: 'wind_speed_mean', group: 'Wind', label: 'Mean wind speed (10 m)', short: 'Mean wind speed', hourly: 'wind_speed_10m', agg: 'mean', unit: 'mph', decimals: 1 },
  { id: 'wind_speed_100_max', group: 'Wind', label: 'Max wind speed (100 m)', short: 'Max wind speed 100 m', hourly: 'wind_speed_100m', agg: 'max', unit: 'mph', decimals: 1 },
  { id: 'wind_speed_100_mean', group: 'Wind', label: 'Mean wind speed (100 m)', short: 'Mean wind speed 100 m', hourly: 'wind_speed_100m', agg: 'mean', unit: 'mph', decimals: 1 },

  // Precipitation
  { id: 'precip_total', group: 'Precipitation', label: 'Total precipitation', short: 'Daily precipitation', hourly: 'precipitation', agg: 'sum', unit: 'in', decimals: 2 },
  { id: 'rain_total', group: 'Precipitation', label: 'Total rain', short: 'Daily rain', hourly: 'rain', agg: 'sum', unit: 'in', decimals: 2 },
  { id: 'snowfall_total', group: 'Precipitation', label: 'Total snowfall', short: 'Daily snowfall', hourly: 'snowfall', agg: 'sum', unit: 'cm', decimals: 2 },
  { id: 'snow_depth_max', group: 'Precipitation', label: 'Max snow depth', short: 'Max snow depth', hourly: 'snow_depth', agg: 'max', unit: 'm', decimals: 2 },

  // Pressure and cloud
  { id: 'pressure_msl_min', group: 'Pressure & cloud', label: 'Min sea-level pressure', short: 'Min MSL pressure', hourly: 'pressure_msl', agg: 'min', unit: 'hPa', decimals: 1 },
  { id: 'pressure_msl_mean', group: 'Pressure & cloud', label: 'Mean sea-level pressure', short: 'Mean MSL pressure', hourly: 'pressure_msl', agg: 'mean', unit: 'hPa', decimals: 1 },
  { id: 'surface_pressure_mean', group: 'Pressure & cloud', label: 'Mean surface pressure', short: 'Mean surface pressure', hourly: 'surface_pressure', agg: 'mean', unit: 'hPa', decimals: 1 },
  { id: 'cloud_cover_mean', group: 'Pressure & cloud', label: 'Mean cloud cover (total)', short: 'Mean cloud cover', hourly: 'cloud_cover', agg: 'mean', unit: '%', decimals: 1 },
  { id: 'cloud_low_mean', group: 'Pressure & cloud', label: 'Mean cloud cover (low)', short: 'Mean low cloud', hourly: 'cloud_cover_low', agg: 'mean', unit: '%', decimals: 1 },
  { id: 'cloud_mid_mean', group: 'Pressure & cloud', label: 'Mean cloud cover (mid)', short: 'Mean mid cloud', hourly: 'cloud_cover_mid', agg: 'mean', unit: '%', decimals: 1 },
  { id: 'cloud_high_mean', group: 'Pressure & cloud', label: 'Mean cloud cover (high)', short: 'Mean high cloud', hourly: 'cloud_cover_high', agg: 'mean', unit: '%', decimals: 1 },

  // Radiation
  { id: 'shortwave_mean', group: 'Solar radiation', label: 'Mean shortwave radiation', short: 'Mean shortwave rad.', hourly: 'shortwave_radiation', agg: 'mean', unit: 'W/m²', decimals: 1 },
  { id: 'direct_mean', group: 'Solar radiation', label: 'Mean direct radiation', short: 'Mean direct rad.', hourly: 'direct_radiation', agg: 'mean', unit: 'W/m²', decimals: 1 },
  { id: 'diffuse_mean', group: 'Solar radiation', label: 'Mean diffuse radiation', short: 'Mean diffuse rad.', hourly: 'diffuse_radiation', agg: 'mean', unit: 'W/m²', decimals: 1 },
  { id: 'dni_mean', group: 'Solar radiation', label: 'Mean direct normal irradiance', short: 'Mean DNI', hourly: 'direct_normal_irradiance', agg: 'mean', unit: 'W/m²', decimals: 1 },
  // Reported per hour in seconds; summed over the day and shown as hours.
  { id: 'sunshine_hours', group: 'Solar radiation', label: 'Sunshine duration', short: 'Sunshine duration', hourly: 'sunshine_duration', agg: 'sum', unit: 'h', decimals: 2, scale: 1 / 3600 },

  // Soil
  { id: 'soil_temp_0_7', group: 'Soil', label: 'Mean soil temperature (0–7 cm)', short: 'Soil temp 0–7 cm', hourly: 'soil_temperature_0_to_7cm', agg: 'mean', unit: '°F', decimals: 1 },
  { id: 'soil_temp_7_28', group: 'Soil', label: 'Mean soil temperature (7–28 cm)', short: 'Soil temp 7–28 cm', hourly: 'soil_temperature_7_to_28cm', agg: 'mean', unit: '°F', decimals: 1 },
  { id: 'soil_temp_28_100', group: 'Soil', label: 'Mean soil temperature (28–100 cm)', short: 'Soil temp 28–100 cm', hourly: 'soil_temperature_28_to_100cm', agg: 'mean', unit: '°F', decimals: 1 },
  { id: 'soil_temp_100_255', group: 'Soil', label: 'Mean soil temperature (100–255 cm)', short: 'Soil temp 100–255 cm', hourly: 'soil_temperature_100_to_255cm', agg: 'mean', unit: '°F', decimals: 1 },
  { id: 'soil_moist_0_7', group: 'Soil', label: 'Mean soil moisture (0–7 cm)', short: 'Soil moisture 0–7 cm', hourly: 'soil_moisture_0_to_7cm', agg: 'mean', unit: 'm³/m³', decimals: 3 },
  { id: 'soil_moist_7_28', group: 'Soil', label: 'Mean soil moisture (7–28 cm)', short: 'Soil moisture 7–28 cm', hourly: 'soil_moisture_7_to_28cm', agg: 'mean', unit: 'm³/m³', decimals: 3 },
  { id: 'soil_moist_28_100', group: 'Soil', label: 'Mean soil moisture (28–100 cm)', short: 'Soil moisture 28–100 cm', hourly: 'soil_moisture_28_to_100cm', agg: 'mean', unit: 'm³/m³', decimals: 3 },
  { id: 'soil_moist_100_255', group: 'Soil', label: 'Mean soil moisture (100–255 cm)', short: 'Soil moisture 100–255 cm', hourly: 'soil_moisture_100_to_255cm', agg: 'mean', unit: 'm³/m³', decimals: 3 },

  // Evapotranspiration
  { id: 'et0_total', group: 'Evapotranspiration', label: 'Total reference ET₀ (FAO)', short: 'Daily ET₀', hourly: 'et0_fao_evapotranspiration', agg: 'sum', unit: 'mm', decimals: 2 },
];

/** Variable ids grouped for the dropdown's optgroups, in declaration order. */
export function variableGroups() {
  const groups = new Map();
  for (const v of VARIABLES) {
    if (!groups.has(v.group)) groups.set(v.group, []);
    groups.get(v.group).push(v);
  }
  return [...groups.entries()];
}

export function getVariable(id) {
  return VARIABLES.find((v) => v.id === id) || VARIABLES[0];
}

// --- date helpers ------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

/** Days in a 1-indexed month for a given year (handles leap Februaries). */
export function daysInMonth(month, year) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "06-15" -> { month: 6, day: 15 } */
function parseMD(md) {
  const [month, day] = md.split('-').map(Number);
  return { month, day };
}

export function formatMD(month, day) {
  return `${pad2(month)}-${pad2(day)}`;
}

/** Feb 29 in a non-leap year clamps to Feb 28. */
function ymdClamped(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(Math.min(day, daysInMonth(month, year)))}`;
}

/**
 * The concrete date range for one "season year". A window that wraps the new year
 * (Dec 20 - Jan 5) ends in the following calendar year and is labeled by its start.
 */
export function rangeForYear(year, startMD, endMD) {
  const s = parseMD(startMD);
  const e = parseMD(endMD);
  const wraps = e.month < s.month || (e.month === s.month && e.day < s.day);
  return {
    start_date: ymdClamped(year, s.month, s.day),
    end_date: ymdClamped(wraps ? year + 1 : year, e.month, e.day),
    wraps,
  };
}

function toEpoch(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * The season years to request, newest last. The most recent year is only included
 * once its window has closed and the archive has caught up; otherwise the whole
 * window shifts back a year.
 */
export function seasonYears(lookback, startMD, endMD, now = new Date()) {
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = todayUTC - ARCHIVE_LAG_DAYS * 86400000;

  let latest = now.getUTCFullYear();
  while (latest > EARLIEST_YEAR && toEpoch(rangeForYear(latest, startMD, endMD).end_date) > cutoff) {
    latest -= 1;
  }

  const first = Math.max(EARLIEST_YEAR, latest - lookback + 1);
  const years = [];
  for (let y = first; y <= latest; y++) years.push(y);
  return { years, truncated: years.length < lookback };
}

/**
 * Inclusive day count of the window as it actually falls in `year`. This differs
 * between years whenever the window covers Feb 29 — a full-year window is 366 days
 * in a leap year and 365 otherwise — so anything comparing "days we got" against
 * "days we expected" has to ask per year rather than multiply one number.
 */
export function daysInWindow(year, startMD, endMD) {
  const { start_date, end_date } = rangeForYear(year, startMD, endMD);
  return Math.round((toEpoch(end_date) - toEpoch(start_date)) / 86400000) + 1;
}

/** Longest the window can be (a leap year), for sizing estimates. */
export function windowLength(startMD, endMD) {
  return daysInWindow(2024, startMD, endMD);
}

/** The distinct per-year lengths of a window, ascending — one entry unless Feb 29 is in range. */
export function windowLengthRange(startMD, endMD, years) {
  const lengths = new Set(years.map((y) => daysInWindow(y, startMD, endMD)));
  return [...lengths].sort((a, b) => a - b);
}

/** "06-15" -> "Jun 15" */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatMDLabel(md) {
  const { month, day } = parseMD(md);
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

// --- aggregation -------------------------------------------------------------

function reduceDay(values, agg) {
  switch (agg) {
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length;
    default:
      throw new WeatherError(`Unknown aggregation "${agg}".`);
  }
}

/**
 * Collapse parallel hourly time/value arrays into one value per local calendar day.
 * Returns [{ date: "YYYY-MM-DD", value }] sorted by date; days with too few
 * readings are dropped.
 */
export function aggregateDaily(times, values, agg) {
  const buckets = new Map();
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    const date = times[i].slice(0, 10);
    if (!buckets.has(date)) buckets.set(date, []);
    buckets.get(date).push(v);
  }

  return [...buckets.entries()]
    .filter(([, vals]) => vals.length >= MIN_HOURS_PER_DAY)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, vals]) => ({ date, value: reduceDay(vals, agg) }));
}

// --- fetching ----------------------------------------------------------------

/** Like a plain delay, but an aborted `signal` cuts the wait short instead of outlasting it. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

/** GET with retries on rate limits and transient server errors. */
async function getJSON(url, { attempts = 3, signal } = {}) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1), signal);

    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = new WeatherError('Network error while fetching weather data.');
      continue;
    }

    if (res.status === 429) {
      lastError = new WeatherError('Open-Meteo rate limit reached. Wait a minute and try again.');
      continue;
    }
    if (res.status >= 500) {
      lastError = new WeatherError(`Open-Meteo is unavailable (HTTP ${res.status}).`);
      continue;
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new WeatherError('Open-Meteo returned an unreadable response.');
    }
    // 4xx responses carry a human-readable `reason`; surface it rather than retrying.
    if (body && body.error) throw new WeatherError(body.reason || 'Open-Meteo rejected the request.');
    if (!res.ok) throw new WeatherError(`Weather request failed (HTTP ${res.status}).`);

    return body;
  }

  throw lastError;
}

function archiveURL({ latitude, longitude, start_date, end_date, hourly, model }) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    start_date,
    end_date,
    hourly,
    models: model,
    timezone: 'auto',
    wind_speed_unit: 'mph',
    temperature_unit: 'fahrenheit',
    precipitation_unit: 'inch',
  });
  return `${ARCHIVE_URL}?${params}`;
}

/** Run `fn` over `items` with a bounded number in flight at once. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Resolve the unit to display. A scaled variable (e.g. sunshine seconds summed and
 * shown as hours) keeps its declared unit; otherwise the API's own label wins, so a
 * change to the unit request parameters can't mislabel an axis.
 */
function resolveUnit(variable, apiUnit) {
  return variable.scale ? variable.unit : apiUnit || variable.unit;
}

function keyFor({ latitude, longitude, variable, startMD, endMD, year, model }) {
  return cache.makeKey({
    latitude, longitude, variableId: variable.id, startMD, endMD, year, model,
  });
}

/**
 * One season year for *every* requested variable, in a single request.
 *
 * Up to 10 variables cost the same as one, so anything not already cached is fetched
 * together. Cache entries stay per variable, so a year that has two of three
 * variables cached only asks for the third.
 *
 * Returns Map<variableId, { days, unit, cached }>.
 */
async function loadYear({ latitude, longitude, variables, startMD, endMD, year, model, signal }) {
  const loaded = new Map();
  const missing = [];

  for (const variable of variables) {
    const hit = cache.get(keyFor({ latitude, longitude, variable, startMD, endMD, year, model }));
    if (hit && Array.isArray(hit.d)) loaded.set(variable.id, { days: hit.d, unit: hit.u, cached: true });
    else missing.push(variable);
  }
  if (missing.length === 0) return loaded;

  // Several variables can share one hourly field — max, min and mean temperature all
  // read temperature_2m — so ask for each field once.
  const fields = [...new Set(missing.map((v) => v.hourly))];
  const { start_date, end_date } = rangeForYear(year, startMD, endMD);
  const body = await getJSON(
    archiveURL({ latitude, longitude, start_date, end_date, hourly: fields.join(','), model }),
    { signal }
  );

  const times = body?.hourly?.time;
  if (!Array.isArray(times)) {
    throw new WeatherError(`Open-Meteo returned no hourly data for ${year}.`);
  }

  for (const variable of missing) {
    const values = body.hourly[variable.hourly];
    if (!Array.isArray(values)) {
      throw new WeatherError(`Open-Meteo returned no ${variable.hourly} data for ${year}.`);
    }
    const scale = variable.scale ?? 1;
    const days = aggregateDaily(times, values, variable.agg).map((d) => [d.date, d.value * scale]);
    const unit = resolveUnit(variable, body?.hourly_units?.[variable.hourly]);

    cache.set(keyFor({ latitude, longitude, variable, startMD, endMD, year, model }), { u: unit, d: days });
    loaded.set(variable.id, { days, unit, cached: false });
  }

  return loaded;
}

/**
 * Fetch (or read from cache) one daily value per day per year, for one or more
 * lookback windows and one or more variables at once.
 *
 * Windows are nested and share an end year, so the union of years is exactly the
 * largest window: fetch that once per variable and slice the smaller windows out of
 * it. Every (variable, year) pair is one request, and they all share the same
 * concurrency pool so three variables aren't three times as slow as one.
 *
 * Returns { datasets, model, years } where each dataset is
 * { variable, unit, windows, cachedYears, fetchedYears } and each window is
 * { lookback, years, points, truncated } with points [{ date, year, value }].
 */
export async function fetchWindows({
  latitude,
  longitude,
  variableIds,
  startMD,
  endMD,
  lookbacks,
  modelId = DEFAULT_MODEL,
  onProgress = () => {},
  signal,
}) {
  const variables = [...new Set(variableIds)].map(getVariable);
  if (variables.length === 0) throw new WeatherError('Select at least one variable.');

  // Snap to the model grid so nearby searches share cache entries (see snapCoord).
  latitude = snapCoord(latitude);
  longitude = snapCoord(longitude);

  const model = getModel(modelId);
  const sortedLookbacks = [...new Set(lookbacks)].sort((a, b) => a - b);
  if (sortedLookbacks.length === 0) throw new WeatherError('Select at least one lookback window.');

  const { years } = seasonYears(Math.max(...sortedLookbacks), startMD, endMD);
  if (years.length === 0) {
    throw new WeatherError('No years in range are covered by the Open-Meteo archive.');
  }

  let done = 0;
  onProgress({ done, total: years.length });

  const loaded = await mapLimit(years, CONCURRENCY, async (year) => {
    const byVariable = await loadYear({
      latitude, longitude, variables, startMD, endMD, year, model: model.id, signal,
    });
    onProgress({ done: ++done, total: years.length });
    return { year, byVariable };
  });

  const datasets = variables.map((variable) => {
    const perYear = loaded
      .map(({ year, byVariable }) => ({ year, ...byVariable.get(variable.id) }))
      .filter((entry) => entry.days);
    const daysByYear = new Map(perYear.map((entry) => [entry.year, entry.days]));

    const windows = sortedLookbacks.map((lookback) => {
      const windowYears = years.slice(-lookback);
      const points = [];
      for (const year of windowYears) {
        for (const [date, value] of daysByYear.get(year) || []) points.push({ date, year, value });
      }
      points.sort((a, b) => (a.date < b.date ? -1 : 1));
      return {
        lookback,
        years: windowYears,
        points,
        truncated: windowYears.length < lookback,
        // Summed per year, so leap years don't make non-leap years look incomplete.
        expectedDays: windowYears.reduce((sum, y) => sum + daysInWindow(y, startMD, endMD), 0),
      };
    });

    return {
      variable,
      windows,
      unit: perYear.find((entry) => entry.unit)?.unit || variable.unit,
      cachedYears: perYear.filter((entry) => entry.cached).length,
      fetchedYears: perYear.filter((entry) => !entry.cached).length,
    };
  });

  return { datasets, model, years };
}
