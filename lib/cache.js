// localStorage cache helpers.
//
// Historical weather never changes, so entries never expire. Keys are namespaced
// with a version prefix so the format can be changed later without colliding with
// stale data from an earlier deploy.

// v2: values are now fetched with the reanalysis model pinned to era5_seamless,
// so entries written under v1 (Open-Meteo's blended default) are not comparable.
const PREFIX = 'weatherhist:v2:';

// Two geocodes of the same place can differ in the last decimal places. Rounding to
// 4 decimals (~11 m) keeps those pointing at the same cache entry.
function roundCoord(n) {
  return Number(n).toFixed(4);
}

/**
 * Build a cache key for one year of one variable at one location.
 * Format: `{lat},{lon}|{variable}|{MM-DD}-{MM-DD}|{year}`
 */
export function makeKey({ latitude, longitude, variableId, startMD, endMD, year }) {
  return [
    `${roundCoord(latitude)},${roundCoord(longitude)}`,
    variableId,
    `${startMD}-${endMD}`,
    year,
  ].join('|');
}

function available() {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false; // e.g. cookies blocked in an embedded context
  }
}

export function get(key) {
  if (!available()) return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Returns true if the value was persisted. Quota errors are non-fatal. */
export function set(key, value) {
  if (!available()) return false;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function ownKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k);
  }
  return keys;
}

/** Removes every WeatherHist entry. Returns the number of entries removed. */
export function clear() {
  if (!available()) return 0;
  const keys = ownKeys();
  keys.forEach((k) => localStorage.removeItem(k));
  return keys.length;
}

/** { entries, bytes } for the cached data, for the debug readout. */
export function stats() {
  if (!available()) return { entries: 0, bytes: 0 };
  let bytes = 0;
  const keys = ownKeys();
  for (const k of keys) bytes += k.length + (localStorage.getItem(k) || '').length;
  return { entries: keys.length, bytes: bytes * 2 }; // UTF-16: 2 bytes per code unit
}
