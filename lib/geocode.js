// Open-Meteo geocoding API wrapper.
// https://open-meteo.com/en/docs/geocoding-api

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

export class GeocodeError extends Error {}

/**
 * Detect a raw coordinate pair like "44.05, -121.31" or "44.05 -121.31".
 * Returns a place object, or null if the input isn't coordinates.
 */
export function parseLatLon(input) {
  const m = String(input)
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;

  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  return {
    latitude,
    longitude,
    name: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
    admin1: '',
    country: '',
    isCoords: true,
  };
}

/** Human-readable one-liner for a geocoding result. */
export function formatPlace(place) {
  const parts = [place.name, place.admin1, place.country].filter(Boolean);
  const label = parts.join(', ');
  if (place.isCoords) return label;
  return `${label} (${place.latitude.toFixed(3)}, ${place.longitude.toFixed(3)})`;
}

/**
 * Geocode a free-text query. Resolves to an array of place objects (possibly
 * empty). Raw lat/long input short-circuits to a single synthetic result.
 */
export async function geocode(query, count = 5) {
  const trimmed = String(query || '').trim();
  if (!trimmed) throw new GeocodeError('Enter a location to search for.');

  const coords = parseLatLon(trimmed);
  if (coords) return [coords];

  const url = `${GEOCODE_URL}?name=${encodeURIComponent(trimmed)}&count=${count}&language=en&format=json`;

  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new GeocodeError('Network error while searching for that location.');
  }

  if (res.status === 429) {
    throw new GeocodeError('Geocoding rate limit reached. Wait a moment and try again.');
  }
  if (!res.ok) {
    throw new GeocodeError(`Geocoding failed (HTTP ${res.status}).`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new GeocodeError('Geocoding returned an unreadable response.');
  }

  if (body.error) throw new GeocodeError(body.reason || 'Geocoding failed.');

  return (body.results || []).map((r) => ({
    latitude: r.latitude,
    longitude: r.longitude,
    name: r.name,
    admin1: r.admin1 || '',
    country: r.country || r.country_code || '',
    isCoords: false,
  }));
}
