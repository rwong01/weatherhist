// WxLookback — wires the DOM controls to geocoding, the archive fetch, and the chart.

import { geocode, formatPlace, GeocodeError } from './lib/geocode.js';
import {
  VARIABLES,
  getVariable,
  fetchDistribution,
  seasonYears,
  daysInMonth,
  formatMD,
  formatMDLabel,
  windowLength,
  WeatherError,
} from './lib/weather.js';
import * as cache from './lib/cache.js';
import { computeBins, computeStats, renderHistogram, destroyChart } from './lib/chart.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Any leap year works as the scaffold for the day dropdowns, so Feb 29 stays pickable.
const LEAP_REFERENCE_YEAR = 2024;

const el = (id) => document.getElementById(id);

const dom = {
  form: el('controls'),
  locationInput: el('location-input'),
  searchBtn: el('search-btn'),
  geoResults: el('geo-results'),
  selectedPlace: el('selected-place'),
  startMonth: el('start-month'),
  startDay: el('start-day'),
  endMonth: el('end-month'),
  endDay: el('end-day'),
  windowNote: el('window-note'),
  variable: el('variable'),
  bins: el('bins'),
  generateBtn: el('generate-btn'),
  clearCacheBtn: el('clear-cache-btn'),
  cacheNote: el('cache-note'),
  status: el('status'),
  results: el('results'),
  resultsTitle: el('results-title'),
  resultsSubtitle: el('results-subtitle'),
  stats: el('stats'),
  canvas: el('histogram'),
  binTableBody: document.querySelector('#bin-table tbody'),
};

const state = {
  place: null,
  /** Last successful fetch, kept so bin changes re-render without re-fetching. */
  result: null,
  inFlight: null,
};

// --- small helpers -----------------------------------------------------------

function setStatus(message, kind = 'info') {
  dom.status.hidden = !message;
  dom.status.textContent = message || '';
  dom.status.classList.toggle('error', kind === 'error');
}

function option(value, label, selected = false) {
  const o = document.createElement('option');
  o.value = String(value);
  o.textContent = label;
  o.selected = selected;
  return o;
}

function formatNumber(value, decimals) {
  return Number.isFinite(value) ? value.toFixed(decimals) : '—';
}

function updateCacheNote() {
  const { entries, bytes } = cache.stats();
  dom.cacheNote.textContent = entries
    ? `${entries} year${entries === 1 ? '' : 's'} cached (${Math.max(1, Math.round(bytes / 1024))} KB)`
    : 'Nothing cached yet';
}

// --- date pickers ------------------------------------------------------------

function fillDays(monthSelect, daySelect) {
  const month = Number(monthSelect.value);
  const max = daysInMonth(month, LEAP_REFERENCE_YEAR);
  const previous = Number(daySelect.value) || 1;

  daySelect.replaceChildren();
  for (let d = 1; d <= max; d++) daySelect.append(option(d, d));
  daySelect.value = String(Math.min(previous, max));
}

function initDatePickers() {
  const today = new Date();
  const end = new Date(today.getTime() + 14 * 86400000);

  for (const select of [dom.startMonth, dom.endMonth]) {
    MONTHS.forEach((name, i) => select.append(option(i + 1, name)));
  }
  dom.startMonth.value = String(today.getMonth() + 1);
  dom.endMonth.value = String(end.getMonth() + 1);

  fillDays(dom.startMonth, dom.startDay);
  fillDays(dom.endMonth, dom.endDay);
  dom.startDay.value = String(today.getDate());
  dom.endDay.value = String(end.getDate());

  dom.startMonth.addEventListener('change', () => {
    fillDays(dom.startMonth, dom.startDay);
    updateWindowNote();
  });
  dom.endMonth.addEventListener('change', () => {
    fillDays(dom.endMonth, dom.endDay);
    updateWindowNote();
  });
  dom.startDay.addEventListener('change', updateWindowNote);
  dom.endDay.addEventListener('change', updateWindowNote);
}

function currentWindow() {
  return {
    startMD: formatMD(Number(dom.startMonth.value), Number(dom.startDay.value)),
    endMD: formatMD(Number(dom.endMonth.value), Number(dom.endDay.value)),
  };
}

function currentLookback() {
  return Number(dom.form.querySelector('input[name="lookback"]:checked').value);
}

function updateWindowNote() {
  const { startMD, endMD } = currentWindow();
  const days = windowLength(startMD, endMD);
  const { years } = seasonYears(currentLookback(), startMD, endMD);
  const wraps = endMD < startMD;

  const parts = [`${days} day${days === 1 ? '' : 's'} per year`];
  if (wraps) parts.push('window wraps into the next calendar year');
  if (years.length) parts.push(`${years[0]}–${years[years.length - 1]} · up to ${days * years.length} data points`);

  dom.windowNote.textContent = parts.join(' · ');
}

// --- location ----------------------------------------------------------------

function selectPlace(place) {
  state.place = place;
  dom.geoResults.hidden = true;
  dom.geoResults.replaceChildren();
  dom.selectedPlace.hidden = false;
  dom.selectedPlace.textContent = `Using ${formatPlace(place)}`;
  setStatus('');
}

function showGeoResults(places) {
  dom.geoResults.replaceChildren();
  for (const place of places) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = '';

    const name = document.createElement('span');
    name.className = 'place-name';
    name.textContent = place.name;

    const meta = document.createElement('span');
    meta.className = 'place-meta';
    meta.textContent = [place.admin1, place.country].filter(Boolean).join(', ') +
      ` · ${place.latitude.toFixed(3)}, ${place.longitude.toFixed(3)}`;

    btn.append(name, meta);
    btn.addEventListener('click', () => selectPlace(place));

    const li = document.createElement('li');
    li.append(btn);
    dom.geoResults.append(li);
  }
  dom.geoResults.hidden = false;
}

async function handleSearch() {
  const query = dom.locationInput.value.trim();
  dom.geoResults.hidden = true;
  dom.searchBtn.disabled = true;
  setStatus('Searching for that location…');

  try {
    const places = await geocode(query);

    if (places.length === 0) {
      setStatus(`No location found for "${query}". Try a city and state, a ZIP code, or raw "lat, long".`, 'error');
      return;
    }
    if (places.length === 1) {
      selectPlace(places[0]);
      return;
    }

    // Ambiguous — let the user disambiguate rather than guessing the first hit.
    showGeoResults(places);
    setStatus(`${places.length} matches — pick one.`);
  } catch (err) {
    setStatus(err instanceof GeocodeError ? err.message : 'Something went wrong while geocoding.', 'error');
  } finally {
    dom.searchBtn.disabled = false;
  }
}

// --- rendering ---------------------------------------------------------------

function renderStats(stats, variable) {
  const d = variable.decimals;
  const rows = [
    ['n (days)', String(stats.n)],
    ['Mean', `${formatNumber(stats.mean, d)} ${variable.unit}`],
    ['Median', `${formatNumber(stats.median, d)} ${variable.unit}`],
    ['Min', `${formatNumber(stats.min, d)} ${variable.unit}`],
    ['Max', `${formatNumber(stats.max, d)} ${variable.unit}`],
    ['Std dev', `${formatNumber(stats.stdDev, d)} ${variable.unit}`],
    ['10th pct', `${formatNumber(stats.p10, d)} ${variable.unit}`],
    ['90th pct', `${formatNumber(stats.p90, d)} ${variable.unit}`],
  ];

  dom.stats.replaceChildren(
    ...rows.map(([term, value]) => {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      wrap.append(dt, dd);
      return wrap;
    })
  );
}

function renderTable(bins, total) {
  const fmt = (v) => v.toFixed(bins.decimals);
  dom.binTableBody.replaceChildren(
    ...bins.counts.map((count, i) => {
      const tr = document.createElement('tr');
      const cells = [
        `${fmt(bins.edges[i])} – ${fmt(bins.edges[i + 1])}`,
        String(count),
        total ? `${((count / total) * 100).toFixed(1)}%` : '0%',
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    })
  );
}

/** Re-derive bins/stats/chart from `state.result` — no network involved. */
function renderResult() {
  const result = state.result;
  if (!result) return;

  const values = result.points.map((p) => p.value);
  const stats = computeStats(values);
  const bins = computeBins(values, dom.bins.value);
  const { variable, years } = result;

  dom.results.hidden = false;
  dom.resultsTitle.textContent =
    `${variable.label} · ${formatMDLabel(result.startMD)} – ${formatMDLabel(result.endMD)}`;

  const span = years.length ? `${years[0]}–${years[years.length - 1]}` : '—';
  const source = result.fetchedYears === 0 ? 'all years from cache' : `${result.fetchedYears} year(s) fetched, ${result.cachedYears} from cache`;
  dom.resultsSubtitle.textContent =
    `${formatPlace(result.place)} · ${years.length} years (${span}) · ${stats.n} days · ${source}`;

  renderStats(stats, variable);
  renderTable(bins, stats.n);
  renderHistogram(dom.canvas, {
    bins,
    stats,
    unit: variable.unit,
    title: variable.short,
    valueDecimals: variable.decimals,
  });

  dom.canvas.setAttribute(
    'aria-label',
    `Histogram of ${variable.label} in ${variable.unit} for ${formatMDLabel(result.startMD)} to ${formatMDLabel(result.endMD)}, ` +
      `${years.length} years, ${stats.n} days. Mean ${formatNumber(stats.mean, variable.decimals)}, ` +
      `range ${formatNumber(stats.min, variable.decimals)} to ${formatNumber(stats.max, variable.decimals)}.`
  );
}

// --- generate ----------------------------------------------------------------

async function handleGenerate(event) {
  event.preventDefault();

  if (!state.place) {
    setStatus('Search for a location first.', 'error');
    dom.locationInput.focus();
    return;
  }

  // A second Generate supersedes the first rather than racing it.
  if (state.inFlight) state.inFlight.abort();
  const controller = new AbortController();
  state.inFlight = controller;

  const { startMD, endMD } = currentWindow();
  const lookback = currentLookback();
  const variableId = dom.variable.value;

  dom.generateBtn.disabled = true;
  setStatus('Loading historical data…');

  try {
    const result = await fetchDistribution({
      latitude: state.place.latitude,
      longitude: state.place.longitude,
      variableId,
      startMD,
      endMD,
      lookback,
      signal: controller.signal,
      onProgress: ({ done, total }) => setStatus(`Loading historical data… ${done}/${total} years`),
    });

    if (controller.signal.aborted) return;

    if (result.points.length === 0) {
      destroyChart();
      dom.results.hidden = true;
      setStatus('Open-Meteo returned no usable data for that location and window.', 'error');
      return;
    }

    state.result = { ...result, place: state.place, startMD, endMD };
    renderResult();

    const notes = [];
    if (result.truncated) notes.push(`Only ${result.years.length} years are available from the archive.`);
    const expected = windowLength(startMD, endMD) * result.years.length;
    if (result.points.length < expected) {
      notes.push(`${expected - result.points.length} day(s) had incomplete hourly data and were skipped.`);
    }
    setStatus(notes.join(' '));
  } catch (err) {
    if (err?.name === 'AbortError') return;
    setStatus(err instanceof WeatherError ? err.message : 'Something went wrong fetching weather data.', 'error');
  } finally {
    if (state.inFlight === controller) {
      state.inFlight = null;
      dom.generateBtn.disabled = false;
    }
    updateCacheNote();
  }
}

// --- init --------------------------------------------------------------------

function init() {
  VARIABLES.forEach((v) => dom.variable.append(option(v.id, v.label)));
  dom.variable.value = 'wind_gust_max'; // the spec's motivating example

  initDatePickers();
  updateWindowNote();
  updateCacheNote();

  dom.searchBtn.addEventListener('click', handleSearch);
  dom.locationInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // don't submit the form before a place is chosen
      handleSearch();
    }
  });
  dom.locationInput.addEventListener('input', () => {
    // Typing invalidates the previously chosen place.
    state.place = null;
    dom.selectedPlace.hidden = true;
  });

  dom.form.addEventListener('submit', handleGenerate);
  dom.form.querySelectorAll('input[name="lookback"]').forEach((r) => r.addEventListener('change', updateWindowNote));

  // Bin count is a pure re-render of already-fetched values.
  dom.bins.addEventListener('change', renderResult);

  dom.clearCacheBtn.addEventListener('click', () => {
    const removed = cache.clear();
    updateCacheNote();
    setStatus(removed ? `Cleared ${removed} cached year${removed === 1 ? '' : 's'}.` : 'Cache was already empty.');
  });

  // Re-render on theme change so the chart's colors follow the page.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.result) renderResult();
  });
}

init();
