// Open-Meteo historical archive wrapper + daily aggregation.
// https://open-meteo.com/en/docs/historical-weather-api

import * as cache from './cache.js';

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

// ERA5 reanalysis starts in 1940 and trails real time by roughly five days.
const EARLIEST_YEAR = 1940;
const ARCHIVE_LAG_DAYS = 6;

// A day is only counted once most of its hours are present, so a partially
// reported day can't masquerade as a low daily max or a small daily total.
const MIN_HOURS_PER_DAY = 20;

// Sequential requests would take ~30s for a 30-year window; four at a time keeps it
// quick without tripping Open-Meteo's rate limiter.
const CONCURRENCY = 4;

export class WeatherError extends Error {}

/** Variable options offered in the dropdown. `agg` reduces a day's hourly values. */
export const VARIABLES = [
  { id: 'wind_speed_max', label: 'Max wind speed (10 m)', hourly: 'wind_speed_10m', agg: 'max', unit: 'mph', decimals: 1 },
  { id: 'wind_gust_max', label: 'Max wind gust (10 m)', hourly: 'wind_gusts_10m', agg: 'max', unit: 'mph', decimals: 1 },
  { id: 'temp_max', label: 'Max temperature (2 m)', hourly: 'temperature_2m', agg: 'max', unit: '°F', decimals: 1 },
  { id: 'temp_min', label: 'Min temperature (2 m)', hourly: 'temperature_2m', agg: 'min', unit: '°F', decimals: 1 },
  { id: 'precip_total', label: 'Total precipitation', hourly: 'precipitation', agg: 'sum', unit: 'in', decimals: 2 },
  { id: 'humidity_mean', label: 'Mean relative humidity (2 m)', hourly: 'relative_humidity_2m', agg: 'mean', unit: '%', decimals: 1 },
];

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

/** One season year's daily values, from cache when possible. */
async function loadYear({ latitude, longitude, variable, startMD, endMD, year, signal }) {
  const key = cache.makeKey({ latitude, longitude, variableId: variable.id, startMD, endMD, year });

  const hit = cache.get(key);
  if (Array.isArray(hit)) return { year, days: hit, cached: true };

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

  const days = aggregateDaily(times, values, variable.agg).map((d) => [d.date, d.value]);
  cache.set(key, days);
  return { year, days, cached: false };
}

/**
 * Fetch (or read from cache) one daily value per day per year in the lookback
 * window.
 *
 * Returns { points, years, unit, cachedYears, fetchedYears, truncated }
 * where points is [{ date, year, value }].
 */
export async function fetchDistribution({
  latitude,
  longitude,
  variableId,
  startMD,
  endMD,
  lookback,
  onProgress = () => {},
  signal,
}) {
  const variable = getVariable(variableId);
  const { years, truncated } = seasonYears(lookback, startMD, endMD);
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

  const points = [];
  for (const { year, days } of perYear) {
    for (const [date, value] of days) points.push({ date, year, value });
  }
  points.sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    points,
    years,
    unit: variable.unit,
    variable,
    truncated,
    cachedYears: perYear.filter((y) => y.cached).length,
    fetchedYears: perYear.filter((y) => !y.cached).length,
  };
}
