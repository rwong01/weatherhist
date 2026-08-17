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
 * The `era5*` options hold one resolution across the whole window, trading per-year
 * accuracy for a like-for-like comparison over time — but they aren't identical to
 * each other. `era5_seamless` upgrades temperature/humidity/soil to ERA5-Land's
 * finer ~11 km grid (still constant across years); `era5` holds every variable at
 * ERA5's uniform ~25 km, trading that finer detail for total uniformity across
 * variables too.
 */
export const MODELS = [
  {
    id: 'best_match',
    shortLabel: 'Best match',
    label: 'Best match — highest resolution per year',
    note: 'IFS HRES (~9 km) from 2017, ERA5/ERA5-Land (~11-25 km) before. Most accurate ' +
      'per year, but that 2017 jump in sharpness can look like a trend when you compare ' +
      'windows that fall on different sides of it.',
    homogeneous: false,
  },
  {
    id: 'era5_seamless',
    shortLabel: 'ERA5 seamless',
    label: 'ERA5 seamless — consistent across years',
    note: 'Same resolution in every year, so windows compare cleanly over time. ' +
      'Resolution still differs by variable, though: ~11 km for temperature, humidity ' +
      'and soil (ERA5-Land, 1950-) vs ~25 km for wind, precipitation and radiation ' +
      '(ERA5, 1940-).',
    homogeneous: true,
  },
  {
    id: 'era5',
    shortLabel: 'ERA5 only',
    label: 'ERA5 only — uniform ~25 km',
    note: 'Every variable at the same ~25 km resolution, in every year, 1940 onward. ' +
      'The most uniform option — it gives up the finer 11 km detail ERA5 seamless uses ' +
      'for temperature, humidity and soil, in exchange for one consistent grid ' +
      'everywhere.',
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
export function estimateCalls({ years, startMD, endMD, fieldCount }) {
  return years.reduce(
    (total, year) => total + callWeight(fieldCount, daysInWindow(year, startMD, endMD)),
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
 * The archive is organised by *hourly field*, and one request can carry up to ten
 * fields for the price of one call. Several useful metrics come out of the same
 * field — daily max, min and mean temperature all read `temperature_2m` — so the
 * field is the unit of both fetching and selection, with its aggregations nested.
 *
 * `unit` is only a fallback label: the real unit comes from the response's
 * `hourly_units`, so changing the unit parameters can't mislabel an axis. `scale`
 * converts the aggregated value, and then the declared unit wins.
 *
 * Deliberately absent, because a histogram of them would mislead rather than inform:
 *   - `wind_direction_10m` / `_100m` — circular degrees. Averaging 350° and 10°
 *     gives 180°, the opposite direction. Direction needs a wind rose, a v1 non-goal.
 *   - `weather_code` — a categorical WMO code; the numeric spacing is meaningless.
 *   - `global_tilted_irradiance` — requires panel tilt/azimuth parameters.
 *   - ensemble spread variables — need `models=era5_ensemble`.
 *
 * Aggregation ids are stable: they are cache keys.
 */
const TEMP = { group: 'Temperature & humidity', unit: '°F', decimals: 1 };
const HUMID = { group: 'Temperature & humidity', unit: '%', decimals: 1 };
const WIND = { group: 'Wind', unit: 'mph', decimals: 1 };
const PRECIP = { group: 'Precipitation', unit: 'in', decimals: 2 };
const PRESSURE = { group: 'Pressure & cloud', unit: 'hPa', decimals: 1 };
const CLOUD = { group: 'Pressure & cloud', unit: '%', decimals: 1 };
const RADIATION = { group: 'Solar radiation', unit: 'W/m²', decimals: 1 };
const SOIL_T = { group: 'Soil', unit: '°F', decimals: 1 };
const SOIL_M = { group: 'Soil', unit: 'm³/m³', decimals: 3 };

const agg = (id, agg_, label, short) => ({ id, agg: agg_, label, short });

export const FIELDS = [
  { hourly: 'temperature_2m', label: 'Temperature (2 m)', short: 'Temperature', ...TEMP, aggregations: [
    agg('temp_max', 'max', 'Max temperature (2 m)', 'Max temperature'),
    agg('temp_min', 'min', 'Min temperature (2 m)', 'Min temperature'),
    agg('temp_mean', 'mean', 'Mean temperature (2 m)', 'Mean temperature'),
  ] },
  { hourly: 'apparent_temperature', label: 'Apparent temperature', short: 'Apparent temp', ...TEMP, aggregations: [
    agg('apparent_max', 'max', 'Max apparent temperature', 'Max apparent temp'),
    agg('apparent_min', 'min', 'Min apparent temperature', 'Min apparent temp'),
  ] },
  { hourly: 'dew_point_2m', label: 'Dew point (2 m)', short: 'Dew point', ...TEMP, aggregations: [
    agg('dewpoint_max', 'max', 'Max dew point (2 m)', 'Max dew point'),
    agg('dewpoint_mean', 'mean', 'Mean dew point (2 m)', 'Mean dew point'),
  ] },
  { hourly: 'relative_humidity_2m', label: 'Relative humidity (2 m)', short: 'Relative humidity', ...HUMID, aggregations: [
    agg('humidity_mean', 'mean', 'Mean relative humidity (2 m)', 'Mean relative humidity'),
    agg('humidity_min', 'min', 'Min relative humidity (2 m)', 'Min relative humidity'),
  ] },
  { hourly: 'vapour_pressure_deficit', label: 'Vapour pressure deficit', short: 'VPD', group: 'Temperature & humidity', unit: 'kPa', decimals: 2, aggregations: [
    agg('vpd_max', 'max', 'Max vapour pressure deficit', 'Max VPD'),
    agg('vpd_mean', 'mean', 'Mean vapour pressure deficit', 'Mean VPD'),
  ] },

  { hourly: 'wind_gusts_10m', label: 'Wind gusts (10 m)', short: 'Wind gusts', ...WIND, aggregations: [
    agg('wind_gust_max', 'max', 'Max wind gust (10 m)', 'Max wind gust'),
  ] },
  { hourly: 'wind_speed_10m', label: 'Wind speed (10 m)', short: 'Wind speed', ...WIND, aggregations: [
    agg('wind_speed_max', 'max', 'Max wind speed (10 m)', 'Max wind speed'),
    agg('wind_speed_mean', 'mean', 'Mean wind speed (10 m)', 'Mean wind speed'),
  ] },
  { hourly: 'wind_speed_100m', label: 'Wind speed (100 m)', short: 'Wind speed 100 m', ...WIND, aggregations: [
    agg('wind_speed_100_max', 'max', 'Max wind speed (100 m)', 'Max wind speed 100 m'),
    agg('wind_speed_100_mean', 'mean', 'Mean wind speed (100 m)', 'Mean wind speed 100 m'),
  ] },

  { hourly: 'precipitation', label: 'Precipitation', short: 'Daily precipitation', ...PRECIP, aggregations: [
    agg('precip_total', 'sum', 'Total precipitation', 'Daily precipitation'),
  ] },
  { hourly: 'rain', label: 'Rain', short: 'Daily rain', ...PRECIP, aggregations: [
    agg('rain_total', 'sum', 'Total rain', 'Daily rain'),
  ] },
  { hourly: 'snowfall', label: 'Snowfall', short: 'Daily snowfall', group: 'Precipitation', unit: 'cm', decimals: 2, aggregations: [
    agg('snowfall_total', 'sum', 'Total snowfall', 'Daily snowfall'),
  ] },
  { hourly: 'snow_depth', label: 'Snow depth', short: 'Snow depth', group: 'Precipitation', unit: 'm', decimals: 2, aggregations: [
    agg('snow_depth_max', 'max', 'Max snow depth', 'Max snow depth'),
  ] },

  { hourly: 'pressure_msl', label: 'Sea-level pressure', short: 'MSL pressure', ...PRESSURE, aggregations: [
    agg('pressure_msl_min', 'min', 'Min sea-level pressure', 'Min MSL pressure'),
    agg('pressure_msl_mean', 'mean', 'Mean sea-level pressure', 'Mean MSL pressure'),
  ] },
  { hourly: 'surface_pressure', label: 'Surface pressure', short: 'Surface pressure', ...PRESSURE, aggregations: [
    agg('surface_pressure_mean', 'mean', 'Mean surface pressure', 'Mean surface pressure'),
  ] },
  { hourly: 'cloud_cover', label: 'Cloud cover (total)', short: 'Cloud cover', ...CLOUD, aggregations: [
    agg('cloud_cover_mean', 'mean', 'Mean cloud cover (total)', 'Mean cloud cover'),
  ] },
  { hourly: 'cloud_cover_low', label: 'Cloud cover (low)', short: 'Low cloud', ...CLOUD, aggregations: [
    agg('cloud_low_mean', 'mean', 'Mean cloud cover (low)', 'Mean low cloud'),
  ] },
  { hourly: 'cloud_cover_mid', label: 'Cloud cover (mid)', short: 'Mid cloud', ...CLOUD, aggregations: [
    agg('cloud_mid_mean', 'mean', 'Mean cloud cover (mid)', 'Mean mid cloud'),
  ] },
  { hourly: 'cloud_cover_high', label: 'Cloud cover (high)', short: 'High cloud', ...CLOUD, aggregations: [
    agg('cloud_high_mean', 'mean', 'Mean cloud cover (high)', 'Mean high cloud'),
  ] },

  { hourly: 'shortwave_radiation', label: 'Shortwave radiation', short: 'Shortwave rad.', ...RADIATION, aggregations: [
    agg('shortwave_mean', 'mean', 'Mean shortwave radiation', 'Mean shortwave rad.'),
  ] },
  { hourly: 'direct_radiation', label: 'Direct radiation', short: 'Direct rad.', ...RADIATION, aggregations: [
    agg('direct_mean', 'mean', 'Mean direct radiation', 'Mean direct rad.'),
  ] },
  { hourly: 'diffuse_radiation', label: 'Diffuse radiation', short: 'Diffuse rad.', ...RADIATION, aggregations: [
    agg('diffuse_mean', 'mean', 'Mean diffuse radiation', 'Mean diffuse rad.'),
  ] },
  { hourly: 'direct_normal_irradiance', label: 'Direct normal irradiance', short: 'DNI', ...RADIATION, aggregations: [
    agg('dni_mean', 'mean', 'Mean direct normal irradiance', 'Mean DNI'),
  ] },
  // Reported per hour in seconds; summed over the day and shown as hours.
  { hourly: 'sunshine_duration', label: 'Sunshine duration', short: 'Sunshine duration', group: 'Solar radiation', unit: 'h', decimals: 2, scale: 1 / 3600, aggregations: [
    agg('sunshine_hours', 'sum', 'Sunshine duration', 'Sunshine duration'),
  ] },

  { hourly: 'soil_temperature_0_to_7cm', label: 'Soil temperature (0–7 cm)', short: 'Soil temp 0–7 cm', ...SOIL_T, aggregations: [
    agg('soil_temp_0_7', 'mean', 'Mean soil temperature (0–7 cm)', 'Soil temp 0–7 cm'),
  ] },
  { hourly: 'soil_temperature_7_to_28cm', label: 'Soil temperature (7–28 cm)', short: 'Soil temp 7–28 cm', ...SOIL_T, aggregations: [
    agg('soil_temp_7_28', 'mean', 'Mean soil temperature (7–28 cm)', 'Soil temp 7–28 cm'),
  ] },
  { hourly: 'soil_temperature_28_to_100cm', label: 'Soil temperature (28–100 cm)', short: 'Soil temp 28–100 cm', ...SOIL_T, aggregations: [
    agg('soil_temp_28_100', 'mean', 'Mean soil temperature (28–100 cm)', 'Soil temp 28–100 cm'),
  ] },
  { hourly: 'soil_temperature_100_to_255cm', label: 'Soil temperature (100–255 cm)', short: 'Soil temp 100–255 cm', ...SOIL_T, aggregations: [
    agg('soil_temp_100_255', 'mean', 'Mean soil temperature (100–255 cm)', 'Soil temp 100–255 cm'),
  ] },
  { hourly: 'soil_moisture_0_to_7cm', label: 'Soil moisture (0–7 cm)', short: 'Soil moisture 0–7 cm', ...SOIL_M, aggregations: [
    agg('soil_moist_0_7', 'mean', 'Mean soil moisture (0–7 cm)', 'Soil moisture 0–7 cm'),
  ] },
  { hourly: 'soil_moisture_7_to_28cm', label: 'Soil moisture (7–28 cm)', short: 'Soil moisture 7–28 cm', ...SOIL_M, aggregations: [
    agg('soil_moist_7_28', 'mean', 'Mean soil moisture (7–28 cm)', 'Soil moisture 7–28 cm'),
  ] },
  { hourly: 'soil_moisture_28_to_100cm', label: 'Soil moisture (28–100 cm)', short: 'Soil moisture 28–100 cm', ...SOIL_M, aggregations: [
    agg('soil_moist_28_100', 'mean', 'Mean soil moisture (28–100 cm)', 'Soil moisture 28–100 cm'),
  ] },
  { hourly: 'soil_moisture_100_to_255cm', label: 'Soil moisture (100–255 cm)', short: 'Soil moisture 100–255 cm', ...SOIL_M, aggregations: [
    agg('soil_moist_100_255', 'mean', 'Mean soil moisture (100–255 cm)', 'Soil moisture 100–255 cm'),
  ] },

  { hourly: 'et0_fao_evapotranspiration', label: 'Reference ET₀ (FAO)', short: 'Daily ET₀', group: 'Evapotranspiration', unit: 'mm', decimals: 2, aggregations: [
    agg('et0_total', 'sum', 'Total reference ET₀ (FAO)', 'Daily ET₀'),
  ] },
];

/**
 * One entry per (field, aggregation). This is what gets cached and binned; the field
 * is what gets requested and selected.
 */
export const VARIABLES = FIELDS.flatMap((field) =>
  field.aggregations.map((a) => ({
    ...a,
    field,
    hourly: field.hourly,
    group: field.group,
    unit: field.unit,
    decimals: field.decimals,
    scale: field.scale,
  }))
);

/** The (field, aggregation) variables belonging to one field. */
export function variablesOf(field) {
  return VARIABLES.filter((v) => v.hourly === field.hourly);
}

export function getField(hourly) {
  return FIELDS.find((f) => f.hourly === hourly) || FIELDS[0];
}

export function getVariable(id) {
  return VARIABLES.find((v) => v.id === id) || VARIABLES[0];
}

/** Fields grouped for the picker's group headings, in declaration order. */
export function fieldGroups() {
  const groups = new Map();
  for (const field of FIELDS) {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  }
  return [...groups.entries()];
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
function resolveUnit(field, apiUnit) {
  return field.scale ? field.unit : apiUnit || field.unit;
}

function keyFor({ latitude, longitude, variable, startMD, endMD, year, model }) {
  return cache.makeKey({
    latitude, longitude, variableId: variable.id, startMD, endMD, year, model,
  });
}

/**
 * One season year for every aggregation of every requested field, in one request.
 *
 * Cache entries are per (field, aggregation), so a field whose max is cached but
 * whose mean is not still has to be re-requested — but only the fields with
 * something missing are asked for, and up to ten of them cost one call.
 *
 * Returns Map<variableId, { days, unit, cached }>.
 */
async function loadYear({ latitude, longitude, fields, startMD, endMD, year, model, signal }) {
  const loaded = new Map();
  const missingFields = [];

  for (const field of fields) {
    const missing = [];
    for (const variable of variablesOf(field)) {
      const hit = cache.get(keyFor({ latitude, longitude, variable, startMD, endMD, year, model }));
      if (hit && Array.isArray(hit.d)) loaded.set(variable.id, { days: hit.d, unit: hit.u, cached: true });
      else missing.push(variable);
    }
    if (missing.length) missingFields.push({ field, missing });
  }
  if (missingFields.length === 0) return loaded;

  const { start_date, end_date } = rangeForYear(year, startMD, endMD);
  const body = await getJSON(
    archiveURL({
      latitude, longitude, start_date, end_date, model,
      hourly: missingFields.map(({ field }) => field.hourly).join(','),
    }),
    { signal }
  );

  const times = body?.hourly?.time;
  if (!Array.isArray(times)) {
    throw new WeatherError(`Open-Meteo returned no hourly data for ${year}.`);
  }

  for (const { field, missing } of missingFields) {
    const values = body.hourly[field.hourly];
    if (!Array.isArray(values)) {
      throw new WeatherError(`Open-Meteo returned no ${field.hourly} data for ${year}.`);
    }
    const unit = resolveUnit(field, body?.hourly_units?.[field.hourly]);
    const scale = field.scale ?? 1;

    // One pass over the hourly array per aggregation — they differ only in how each
    // day is reduced, so the field is fetched once regardless of how many there are.
    for (const variable of missing) {
      const days = aggregateDaily(times, values, variable.agg).map((d) => [d.date, d.value * scale]);
      cache.set(keyFor({ latitude, longitude, variable, startMD, endMD, year, model }), { u: unit, d: days });
      loaded.set(variable.id, { days, unit, cached: false });
    }
  }

  return loaded;
}

/**
 * Fetch (or read from cache) one daily value per day per year, for one or more
 * lookback windows and one or more *fields* — every aggregation of a field comes back
 * together, because they all read the same hourly array.
 *
 * Returns { datasets, model, years } where each dataset is
 * { field, unit, variants, cachedYears, fetchedYears }, each variant is
 * { variable, windows }, and each window is { lookback, years, points, truncated,
 * expectedDays } with points [{ date, year, value }].
 */
export async function fetchWindows({
  latitude,
  longitude,
  fieldIds,
  startMD,
  endMD,
  lookbacks,
  modelId = DEFAULT_MODEL,
  onProgress = () => {},
  signal,
}) {
  const fields = [...new Set(fieldIds)].map(getField);
  if (fields.length === 0) throw new WeatherError('Select at least one variable.');

  const model = getModel(modelId);
  const sortedLookbacks = [...new Set(lookbacks)].sort((a, b) => a - b);
  if (sortedLookbacks.length === 0) throw new WeatherError('Select at least one lookback window.');

  const { years } = seasonYears(Math.max(...sortedLookbacks), startMD, endMD);
  if (years.length === 0) {
    throw new WeatherError('No years in range are covered by the Open-Meteo archive.');
  }

  // Snap to the model grid so nearby searches share cache entries (see snapCoord).
  latitude = snapCoord(latitude);
  longitude = snapCoord(longitude);

  let done = 0;
  onProgress({ done, total: years.length });

  const loaded = await mapLimit(years, CONCURRENCY, async (year) => {
    const byVariable = await loadYear({
      latitude, longitude, fields, startMD, endMD, year, model: model.id, signal,
    });
    onProgress({ done: ++done, total: years.length });
    return { year, byVariable };
  });

  const windowsFor = (daysByYear) =>
    sortedLookbacks.map((lookback) => {
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

  const datasets = fields.map((field) => {
    const variants = variablesOf(field).map((variable) => {
      const perYear = loaded
        .map(({ year, byVariable }) => ({ year, ...byVariable.get(variable.id) }))
        .filter((entry) => entry.days);
      return { variable, windows: windowsFor(new Map(perYear.map((e) => [e.year, e.days]))) };
    });

    // Cache stats are per field: one request served all of its aggregations.
    const firstVariable = variablesOf(field)[0];
    const perYear = loaded.map(({ byVariable }) => byVariable.get(firstVariable.id)).filter(Boolean);

    return {
      field,
      variants,
      unit: perYear.find((entry) => entry.unit)?.unit || field.unit,
      cachedYears: perYear.filter((entry) => entry.cached).length,
      fetchedYears: perYear.filter((entry) => !entry.cached).length,
    };
  });

  return { datasets, model, years };
}
