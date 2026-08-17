// localStorage cache helpers.
//
// Historical weather never changes, so entries never expire. Keys are namespaced
// with a version prefix so the format can be changed later without colliding with
// stale data from an earlier deploy.

// v2 stores { u: unit, d: [[date, value], ...] } and carries the reanalysis model
// in the key, since the same year under a different model is a different number.
const PREFIX = 'weatherhist:v2:';

// Prefixes this app used before. "Clear cache" sweeps them too, so entries written
// by an earlier deploy can't linger unreachable in a browser's localStorage.
const LEGACY_PREFIXES = ['weatherhist:v1:', 'wxlookback:v1:'];

// Two geocodes of the same place can differ in the last decimal places. Rounding to
// 4 decimals (~11 m) keeps those pointing at the same cache entry.
function roundCoord(n) {
  return Number(n).toFixed(4);
}

/**
 * Build a cache key for one year of one variable at one location.
 * Format: `{lat},{lon}|{variable}|{MM-DD}-{MM-DD}|{year}`
 */
export function makeKey({ latitude, longitude, variableId, startMD, endMD, year, model }) {
  return [
    `${roundCoord(latitude)},${roundCoord(longitude)}`,
    variableId,
    `${startMD}-${endMD}`,
    year,
    model,
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

// Insertion order of the keys we've written, so a full store can be pruned oldest
// first. Kept as its own entry rather than derived from localStorage's key order,
// which is not specified to be insertion order.
const INDEX_KEY = `${PREFIX}__index`;

// How much to drop when the store is full. Evicting one entry at a time would mean a
// setItem attempt per eviction; a batch amortises that.
const EVICT_FRACTION = 0.25;

function readIndex() {
  try {
    const parsed = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(keys) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(keys));
  } catch {
    // If even the index won't fit there is nothing useful left to do.
  }
}

/**
 * Persist a value, pruning the oldest entries if the store is full.
 *
 * Without this, a full `localStorage` made every write fail silently: the cache
 * stopped growing, so every later query re-fetched from the API and burned quota
 * with no sign anything was wrong. A 30-year full-year query for three variables is
 * most of a megabyte, so filling a ~5 MB store takes only a handful of them.
 *
 * Returns true if the value was persisted.
 */
export function set(key, value) {
  if (!available()) return false;

  const full = PREFIX + key;
  const payload = JSON.stringify(value);
  let index = readIndex().filter((k) => k !== key);

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      localStorage.setItem(full, payload);
      index.push(key);
      writeIndex(index);
      return true;
    } catch {
      // Almost certainly a quota error. Drop the oldest slice and try again; give up
      // once there is nothing of ours left to drop.
      if (index.length === 0) return false;
      const drop = Math.max(1, Math.ceil(index.length * EVICT_FRACTION));
      for (const stale of index.slice(0, drop)) localStorage.removeItem(PREFIX + stale);
      index = index.slice(drop);
      writeIndex(index);
    }
  }
  return false;
}

function ownKeys(prefixes = [PREFIX]) {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && prefixes.some((p) => k.startsWith(p))) keys.push(k);
  }
  return keys;
}

/** Removes every WeatherHist entry. Returns the number of data entries removed. */
export function clear() {
  if (!available()) return 0;
  const keys = ownKeys([PREFIX, ...LEGACY_PREFIXES]);
  keys.forEach((k) => localStorage.removeItem(k));
  // The index is bookkeeping, not data, so don't count it in what the user is told.
  return keys.filter((k) => k !== INDEX_KEY).length;
}

/** { entries, bytes } for the cached data, for the debug readout. */
export function stats() {
  if (!available()) return { entries: 0, bytes: 0 };
  let bytes = 0;
  const keys = ownKeys().filter((k) => k !== INDEX_KEY);
  for (const k of keys) bytes += k.length + (localStorage.getItem(k) || '').length;
  return { entries: keys.length, bytes: bytes * 2 }; // UTF-16: 2 bytes per code unit
}
