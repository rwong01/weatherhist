// Open-Meteo historical archive wrapper + daily aggregation.
// https://open-meteo.com/en/docs/historical-weather-api

import * as cache from './cache.js';

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

// Pin the reanalysis rather than taking Open-Meteo's default.
//
// The default (`best_match`) "combines IFS HRES, ERA5 and ERA5-Land seamlessly",
// and IFS HRES only covers 2017 onward. That would make a lookback window
// inhomogeneous — the recent years would come from a 9 km operational analysis and
// the older years from 25 km ERA5 — so a shift in the distribution could be an
// artifact of the model changing rather than the weather changing. That matters
// most when comparing a 10-year window against a 30-year one.
//
// `era5_seamless` is a single consistent reanalysis family for the whole window:
// temperature and humidity from ERA5-Land (0.1°, 1950-), wind and precipitation
// from ERA5 (0.25°, 1940-). Swap to 'era5' for uniform 0.25° ERA5 everywhere.
const MODEL = 'era5_seamless';

// ERA5 starts in 1940 and trails real time by roughly five days.
const EARLIEST_YEAR = 1940;
const ARCHIVE_LAG_DAYS = 6;

// A day is only counted once most of its hours are present, so a partially
// reported day can't masquerade as a low daily max or a small daily total.
const MIN_HOURS_PER_DAY = 20;

// Sequential requests would take ~30s for a 30-year window; four at a time keeps it
// quick without tripping Open-Meteo's rate limiter.
const CONCURRENCY = 4;

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
export function parseMD(md) {
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

/** Inclusive day count of a month/day window, using a leap year so Feb 29 counts. */
export function windowLength(startMD, endMD) {
  const { start_date, end_date } = rangeForYear(2024, startMD, endMD);
  return Math.round((toEpoch(end_date) - toEpoch(start_date)) / 86400000) + 1;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with retries on rate limits and transient server errors. */
async function getJSON(url, { attempts = 3, signal } = {}) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));

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

function archiveURL({ latitude, longitude, start_date, end_date, hourly }) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    start_date,
    end_date,
    hourly,
    models: MODEL,
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

/** One season year's daily values, from cache when possible. */
async function loadYear({ latitude, longitude, variable, startMD, endMD, year, signal }) {
  const key = cache.makeKey({ latitude, longitude, variableId: variable.id, startMD, endMD, year });

  const hit = cache.get(key);
  if (hit && Array.isArray(hit.d)) return { year, days: hit.d, unit: hit.u, cached: true };

  const { start_date, end_date } = rangeForYear(year, startMD, endMD);
  const body = await getJSON(
    archiveURL({ latitude, longitude, start_date, end_date, hourly: variable.hourly }),
    { signal }
  );

  const times = body?.hourly?.time;
  const values = body?.hourly?.[variable.hourly];
  if (!Array.isArray(times) || !Array.isArray(values)) {
    throw new WeatherError(`Open-Meteo returned no ${variable.hourly} data for ${year}.`);
  }

  const scale = variable.scale ?? 1;
  const days = aggregateDaily(times, values, variable.agg).map((d) => [d.date, d.value * scale]);
  const unit = resolveUnit(variable, body?.hourly_units?.[variable.hourly]);

  cache.set(key, { u: unit, d: days });
  return { year, days, unit, cached: false };
}

/**
 * Fetch (or read from cache) one daily value per day per year, for one or more
 * lookback windows at once.
 *
 * The windows are nested and share an end year, so the union of years is exactly
 * the largest window: fetch that once and slice the smaller windows out of it,
 * rather than issuing overlapping requests per window.
 *
 * Returns { windows, variable, unit, cachedYears, fetchedYears } where each window
 * is { lookback, years, points, truncated } and points is [{ date, year, value }].
 */
export async function fetchWindows({
  latitude,
  longitude,
  variableId,
  startMD,
  endMD,
  lookbacks,
  onProgress = () => {},
  signal,
}) {
  const variable = getVariable(variableId);
  const sorted = [...new Set(lookbacks)].sort((a, b) => a - b);
  if (sorted.length === 0) throw new WeatherError('Select at least one lookback window.');

  const { years } = seasonYears(Math.max(...sorted), startMD, endMD);
  if (years.length === 0) {
    throw new WeatherError('No years in range are covered by the Open-Meteo archive.');
  }

  let done = 0;
  onProgress({ done, total: years.length });

  const perYear = await mapLimit(years, CONCURRENCY, async (year) => {
    const result = await loadYear({ latitude, longitude, variable, startMD, endMD, year, signal });
    onProgress({ done: ++done, total: years.length });
    return result;
  });

  const daysByYear = new Map(perYear.map((y) => [y.year, y.days]));

  const windows = sorted.map((lookback) => {
    const windowYears = years.slice(-lookback);
    const points = [];
    for (const year of windowYears) {
      for (const [date, value] of daysByYear.get(year)) points.push({ date, year, value });
    }
    points.sort((a, b) => (a.date < b.date ? -1 : 1));
    return { lookback, years: windowYears, points, truncated: windowYears.length < lookback };
  });

  return {
    windows,
    variable,
    unit: perYear.find((y) => y.unit)?.unit || variable.unit,
    cachedYears: perYear.filter((y) => y.cached).length,
    fetchedYears: perYear.filter((y) => !y.cached).length,
  };
}
