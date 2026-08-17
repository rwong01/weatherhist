// Recently used locations, for this browser session only.
//
// Deliberately `sessionStorage`, not `localStorage`: this is a convenience for the
// run of work someone is doing right now, and it disappears when the tab closes.
// Nothing is shared between users or sent anywhere — it never leaves the browser.
// (Switching the two constants below to localStorage would make it persist across
// visits instead.)

const KEY = 'weatherhist:recent-places';
const MAX = 5;

function store() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null; // storage can be blocked outright
  }
}

/** Same rounding as the data cache, so "the same place" means the same entry. */
function sameSpot(a, b) {
  return (
    Number(a.latitude).toFixed(4) === Number(b.latitude).toFixed(4) &&
    Number(a.longitude).toFixed(4) === Number(b.longitude).toFixed(4)
  );
}

/** Most recently used first. */
export function list() {
  const s = store();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((p) => Number.isFinite(p?.latitude)) : [];
  } catch {
    return [];
  }
}

/** Record a place, moving an existing entry back to the front rather than duplicating. */
export function add(place) {
  const s = store();
  if (!s) return list();

  const entry = {
    latitude: place.latitude,
    longitude: place.longitude,
    name: place.name,
    admin1: place.admin1 || '',
    country: place.country || '',
    isCoords: Boolean(place.isCoords),
  };
  const next = [entry, ...list().filter((p) => !sameSpot(p, entry))].slice(0, MAX);

  try {
    s.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or private-mode failures are non-fatal; the app just won't remember.
  }
  return next;
}

export function clear() {
  store()?.removeItem(KEY);
}
