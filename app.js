// WeatherHist — wires the DOM controls to geocoding, the archive fetch, and the chart.

import { geocode, formatPlace, GeocodeError } from './lib/geocode.js';
import {
  variableGroups,
  MODELS,
  DEFAULT_MODEL,
  getModel,
  fetchWindows,
  seasonYears,
  daysInMonth,
  formatMD,
  formatMDLabel,
  windowLength,
  WeatherError,
} from './lib/weather.js';
import * as cache from './lib/cache.js';
import {
  computeEdges,
  binValues,
  binLabels,
  computeStats,
  renderHistogram,
  destroyChart,
  getChart,
  readTheme,
} from './lib/chart.js';
import { downloadCSV, downloadChartPNG, slug } from './lib/export.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Any leap year works as the scaffold for the day dropdowns, so Feb 29 stays pickable.
const LEAP_REFERENCE_YEAR = 2024;

const ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';

// Kept outside the data-cache namespace so "Clear cache" doesn't reset the theme.
const THEME_KEY = 'weatherhist:theme';

/** Provenance line for exports — the model materially changes the numbers. */
const sourceLine = (model) => `${ATTRIBUTION} · reanalysis: ${model.id}`;

const el = (id) => document.getElementById(id);

const dom = {
  form: el('controls'),
  locationInput: el('location-input'),
  searchBtn: el('search-btn'),
  geoResults: el('geo-results'),
  selectedPlace: el('selected-place'),
  preset: el('preset'),
  startMonth: el('start-month'),
  startDay: el('start-day'),
  endMonth: el('end-month'),
  endDay: el('end-day'),
  windowNote: el('window-note'),
  variable: el('variable'),
  model: el('model'),
  modelNote: el('model-note'),
  bins: el('bins'),
  generateBtn: el('generate-btn'),
  clearCacheBtn: el('clear-cache-btn'),
  cacheNote: el('cache-note'),
  exportPngBtn: el('export-png-btn'),
  exportCsvBtn: el('export-csv-btn'),
  status: el('status'),
  results: el('results'),
  resultsTitle: el('results-title'),
  resultsSubtitle: el('results-subtitle'),
  stats: el('stats'),
  canvas: el('histogram'),
  themeInputs: document.querySelectorAll('input[name="theme"]'),
  binTableHead: document.querySelector('#bin-table thead'),
  binTableBody: document.querySelector('#bin-table tbody'),
};

const state = {
  place: null,
  /** Last successful fetch, kept so bin changes re-render without re-fetching. */
  result: null,
  /** What the last render produced, so exports match exactly what's on screen. */
  view: null,
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

function cell(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function swatch(color) {
  const s = document.createElement('span');
  s.className = 'swatch';
  s.style.background = color;
  return s;
}

function updateCacheNote() {
  const { entries, bytes } = cache.stats();
  dom.cacheNote.textContent = entries
    ? `${entries} year${entries === 1 ? '' : 's'} cached (${Math.max(1, Math.round(bytes / 1024))} KB)`
    : 'Nothing cached yet';
}

// --- theme -------------------------------------------------------------------

/**
 * "auto" removes the attribute so the prefers-color-scheme media query takes over;
 * "light"/"dark" stamp it so an explicit choice beats the OS in both directions.
 */
function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') {
    document.documentElement.dataset.theme = choice;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // Storage can be blocked; the control still works for this page view.
  }
  const choice = ['light', 'dark', 'auto'].includes(saved) ? saved : 'auto';

  applyTheme(choice);
  for (const input of dom.themeInputs) {
    input.checked = input.value === choice;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      applyTheme(input.value);
      try {
        localStorage.setItem(THEME_KEY, input.value);
      } catch {
        // Non-fatal: the choice just won't survive a reload.
      }
      // Chart colours are read from CSS custom properties, so it must re-render.
      if (state.result) renderResult();
    });
  }
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
    onWindowChanged();
  });
  dom.endMonth.addEventListener('change', () => {
    fillDays(dom.endMonth, dom.endDay);
    onWindowChanged();
  });
  dom.startDay.addEventListener('change', onWindowChanged);
  dom.endDay.addEventListener('change', onWindowChanged);
}

/** Quick-select presets; "custom" leaves the pickers alone. */
function applyPreset() {
  if (dom.preset.value !== 'full-year') return;

  dom.startMonth.value = '1';
  fillDays(dom.startMonth, dom.startDay);
  dom.startDay.value = '1';

  dom.endMonth.value = '12';
  fillDays(dom.endMonth, dom.endDay);
  dom.endDay.value = '31';

  onWindowChanged();
}

/** Hand-editing the pickers means the preset no longer describes them. */
function onWindowChanged() {
  const { startMD, endMD } = currentWindow();
  dom.preset.value = startMD === '01-01' && endMD === '12-31' ? 'full-year' : 'custom';
  updateWindowNote();
  updateChipYears();
}

function currentWindow() {
  return {
    startMD: formatMD(Number(dom.startMonth.value), Number(dom.startDay.value)),
    endMD: formatMD(Number(dom.endMonth.value), Number(dom.endDay.value)),
  };
}

/**
 * Explain the selected model, and warn when it is inhomogeneous *and* more than one
 * window is selected — that combination is the one where the resolution change at
 * 2017 can be mistaken for a trend.
 */
function updateModelNote() {
  const model = getModel(dom.model.value);
  // The dropdown labels already describe each model, so the full description lives
  // in the tooltip. Only the caution — which no label can express — gets prose.
  dom.model.title = model.note;

  const warn = currentLookbacks().length > 1 && !model.homogeneous;
  dom.modelNote.hidden = !warn;
  dom.modelNote.classList.toggle('warn', warn);
  dom.modelNote.textContent = warn
    ? 'Comparing windows on this model: part of the difference between them may come' +
      ' from its 2017 resolution change rather than the weather.'
    : '';
}

function currentLookbacks() {
  return [...dom.form.querySelectorAll('input[name="lookback"]:checked')]
    .map((input) => Number(input.value))
    .sort((a, b) => a - b);
}

/** Show the concrete years behind each window's label. */
function updateChipYears() {
  const { startMD, endMD } = currentWindow();
  for (const node of dom.form.querySelectorAll('.chip-years')) {
    const { years } = seasonYears(Number(node.dataset.yearsFor), startMD, endMD);
    node.textContent = years.length ? `${years[0]}–${years[years.length - 1]}` : '—';
  }
}

/**
 * Tint each ticked chip with the colour its series will have in the chart, so the
 * selector doubles as the legend. Colours follow position among the checked boxes,
 * matching how renderResult assigns them.
 */
function updateChipColors() {
  const colors = readTheme().seriesColors;
  let checkedIndex = 0;
  for (const input of dom.form.querySelectorAll('input[name="lookback"]')) {
    const chip = input.closest('.chip');
    if (input.checked) {
      chip.style.setProperty('--chip-color', colors[checkedIndex % colors.length]);
      checkedIndex += 1;
    } else {
      chip.style.removeProperty('--chip-color');
    }
  }
}

function updateWindowNote() {
  const { startMD, endMD } = currentWindow();
  const lookbacks = currentLookbacks();
  const days = windowLength(startMD, endMD);

  // Only what the controls can't already show: the window's length in days, the
  // wrap, and how much will be fetched.
  const parts = [`${days} days per year`];
  if (endMD < startMD) parts.push('wraps into the next year');
  if (lookbacks.length) {
    // The windows are nested, so the largest is all the data actually fetched.
    const { years } = seasonYears(Math.max(...lookbacks), startMD, endMD);
    parts.push(`${years.length} years to load`);
  }

  dom.windowNote.textContent = parts.join(' · ');
  dom.generateBtn.disabled = lookbacks.length === 0 || Boolean(state.inFlight);
  updateChipColors();
  updateModelNote();
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
    btn.append(
      cell('span', place.name, 'place-name'),
      cell(
        'span',
        [place.admin1, place.country].filter(Boolean).join(', ') +
          ` · ${place.latitude.toFixed(3)}, ${place.longitude.toFixed(3)}`,
        'place-meta'
      )
    );
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

const STAT_COLUMNS = [
  ['n (days)', (s) => s.n, true],
  ['Mean', (s) => s.mean],
  ['Median', (s) => s.median],
  ['Min', (s) => s.min],
  ['Max', (s) => s.max],
  ['Std dev', (s) => s.stdDev],
  ['10th pct', (s) => s.p10],
  ['90th pct', (s) => s.p90],
];

/** Tile grid for a single window. */
function renderStatTiles(series, variable, unit) {
  const dl = document.createElement('dl');
  dl.className = 'stats';

  for (const [label, get, isCount] of STAT_COLUMNS) {
    const value = get(series.stats);
    const wrap = document.createElement('div');
    wrap.append(
      cell('dt', label),
      cell('dd', isCount ? String(value) : `${formatNumber(value, variable.decimals)} ${unit}`)
    );
    dl.append(wrap);
  }
  dom.stats.replaceChildren(dl);
}

/** One row per window when they're overlaid, so the windows compare directly. */
function renderStatTable(allSeries, variable, unit) {
  const table = document.createElement('table');
  table.className = 'stats-table';

  const headRow = document.createElement('tr');
  headRow.append(cell('th', 'Window'));
  for (const [label] of STAT_COLUMNS) headRow.append(cell('th', label));
  const thead = document.createElement('thead');
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  for (const series of allSeries) {
    const tr = document.createElement('tr');
    const th = cell('th', '');
    th.scope = 'row';
    th.append(swatch(series.color), document.createTextNode(`${series.label} (${series.yearSpan})`));
    tr.append(th);

    for (const [, get, isCount] of STAT_COLUMNS) {
      const value = get(series.stats);
      tr.append(cell('td', isCount ? String(value) : formatNumber(value, variable.decimals)));
    }
    tbody.append(tr);
  }

  table.append(thead, tbody);
  table.prepend(cell('caption', `All values in ${unit} unless noted.`, 'visually-hidden'));
  dom.stats.replaceChildren(table);
}

/** Bin table: one Days/Share column pair per window. */
function renderBinTable(edges, decimals, allSeries) {
  const multi = allSeries.length > 1;

  const headRow = document.createElement('tr');
  headRow.append(cell('th', 'Range'));
  for (const series of allSeries) {
    const days = cell('th', multi ? `${series.label} days` : 'Days');
    days.prepend(swatch(series.color));
    headRow.append(days, cell('th', multi ? `${series.label} share` : 'Share'));
  }
  dom.binTableHead.replaceChildren(headRow);

  dom.binTableBody.replaceChildren(
    ...binLabels(edges, decimals).map((label, i) => {
      const tr = document.createElement('tr');
      tr.append(cell('td', label));
      for (const series of allSeries) {
        const count = series.counts[i];
        const total = series.stats.n;
        tr.append(
          cell('td', String(count)),
          cell('td', total ? `${((count / total) * 100).toFixed(1)}%` : '0%')
        );
      }
      return tr;
    })
  );
}

/** Re-derive bins/stats/chart from `state.result` — no network involved. */
function renderResult() {
  const result = state.result;
  if (!result) return;

  const { variable, windows, unit } = result;
  const theme = readTheme();

  // One shared set of edges across every window, so the overlay lines up.
  const pooled = windows.flatMap((w) => w.points.map((p) => p.value));
  const { edges, decimals } = computeEdges(pooled, dom.bins.value);

  const series = windows.map((w, i) => {
    const values = w.points.map((p) => p.value);
    return {
      lookback: w.lookback,
      label: `${w.lookback} yr`,
      years: w.years,
      yearSpan: `${w.years[0]}–${w.years[w.years.length - 1]}`,
      color: theme.seriesColors[i % theme.seriesColors.length],
      counts: binValues(values, edges),
      stats: computeStats(values),
    };
  });

  dom.results.hidden = false;
  dom.resultsTitle.textContent =
    `${variable.label} · ${formatMDLabel(result.startMD)} – ${formatMDLabel(result.endMD)}`;

  const source = result.fetchedYears === 0
    ? 'all years from cache'
    : `${result.fetchedYears} year(s) fetched, ${result.cachedYears} from cache`;
  dom.resultsSubtitle.textContent = [
    formatPlace(result.place),
    series.map((s) => `${s.label} (${s.yearSpan})`).join(' · '),
    result.model.id,
    source,
  ].join(' · ');

  if (series.length === 1) renderStatTiles(series[0], variable, unit);
  else renderStatTable(series, variable, unit);

  renderBinTable(edges, decimals, series);
  renderHistogram(dom.canvas, {
    edges,
    decimals,
    series,
    unit,
    title: variable.short,
    valueDecimals: variable.decimals,
  });

  const summary = series
    .map((s) => `${s.label}: ${s.stats.n} days, mean ${formatNumber(s.stats.mean, variable.decimals)}`)
    .join('; ');
  dom.canvas.setAttribute(
    'aria-label',
    `Histogram of ${variable.label} in ${unit} for ` +
      `${formatMDLabel(result.startMD)} to ${formatMDLabel(result.endMD)}. ${summary}.`
  );

  state.view = { edges, decimals, series, variable, unit, result };
}

// --- exports -----------------------------------------------------------------

function exportBaseName() {
  const { variable, series, result } = state.view;
  return [
    'weatherhist',
    slug(variable.short),
    `${result.startMD}_${result.endMD}`,
    series.map((s) => `${s.lookback}y`).join('-'),
  ].join('_');
}

function handleExportPNG() {
  const chart = getChart();
  if (!chart || !state.view) return;

  downloadChartPNG(chart, {
    title: dom.resultsTitle.textContent,
    subtitle: dom.resultsSubtitle.textContent,
    footer: sourceLine(state.view.result.model),
    theme: readTheme(),
    filename: `${exportBaseName()}.png`,
  });
}

function handleExportCSV() {
  if (!state.view) return;
  const { edges, decimals, series, variable, unit, result } = state.view;

  const header = ['bin_start', 'bin_end'];
  for (const s of series) header.push(`${s.lookback}y_days`, `${s.lookback}y_share_pct`);

  const rows = [header];
  for (let i = 0; i < edges.length - 1; i++) {
    const row = [edges[i].toFixed(decimals), edges[i + 1].toFixed(decimals)];
    for (const s of series) {
      const count = s.counts[i];
      row.push(count, s.stats.n ? ((count / s.stats.n) * 100).toFixed(1) : '0.0');
    }
    rows.push(row);
  }

  // Provenance below the data, so the header row stays first for spreadsheet imports.
  rows.push(
    [],
    ['variable', `${variable.label} (${unit})`],
    ['aggregation', `daily ${variable.agg}`],
    ['location', formatPlace(result.place)],
    ['latitude', result.place.latitude],
    ['longitude', result.place.longitude],
    ['date_window', `${result.startMD} to ${result.endMD}`],
    ['reanalysis_model', result.model.id],
    ...series.map((s) => [`${s.lookback}y_years`, `${s.yearSpan} (n=${s.stats.n} days)`]),
    ['source', sourceLine(result.model)]
  );

  downloadCSV(rows, `${exportBaseName()}.csv`);
}

// --- generate ----------------------------------------------------------------

async function handleGenerate(event) {
  event.preventDefault();

  if (!state.place) {
    setStatus('Search for a location first.', 'error');
    dom.locationInput.focus();
    return;
  }

  const lookbacks = currentLookbacks();
  if (lookbacks.length === 0) {
    setStatus('Pick at least one lookback window.', 'error');
    return;
  }

  // A second Generate supersedes the first rather than racing it.
  if (state.inFlight) state.inFlight.abort();
  const controller = new AbortController();
  state.inFlight = controller;

  const { startMD, endMD } = currentWindow();
  const variableId = dom.variable.value;

  dom.generateBtn.disabled = true;
  setStatus('Loading historical data…');

  try {
    const result = await fetchWindows({
      latitude: state.place.latitude,
      longitude: state.place.longitude,
      variableId,
      startMD,
      endMD,
      lookbacks,
      modelId: dom.model.value,
      signal: controller.signal,
      onProgress: ({ done, total }) => setStatus(`Loading historical data… ${done}/${total} years`),
    });

    if (controller.signal.aborted) return;

    if (result.windows.every((w) => w.points.length === 0)) {
      destroyChart();
      dom.results.hidden = true;
      state.view = null;
      setStatus(
        `Open-Meteo returned no ${result.variable.hourly} data for that location and window.`,
        'error'
      );
      return;
    }

    state.result = { ...result, place: state.place, startMD, endMD };
    renderResult();

    const notes = [];
    const perYear = windowLength(startMD, endMD);
    for (const w of result.windows) {
      if (w.truncated) notes.push(`Only ${w.years.length} of ${w.lookback} years are in the archive.`);
      const missing = perYear * w.years.length - w.points.length;
      if (missing > 0) notes.push(`${w.lookback}y: ${missing} day(s) had incomplete hourly data and were skipped.`);
    }
    setStatus(notes.join(' '));
  } catch (err) {
    if (err?.name === 'AbortError') return;
    setStatus(err instanceof WeatherError ? err.message : 'Something went wrong fetching weather data.', 'error');
  } finally {
    if (state.inFlight === controller) {
      state.inFlight = null;
      updateWindowNote(); // re-enables Generate if a window is still selected
    }
    updateCacheNote();
  }
}

// --- init --------------------------------------------------------------------

function initVariableSelect() {
  for (const [group, variables] of variableGroups()) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    for (const v of variables) optgroup.append(option(v.id, v.label));
    dom.variable.append(optgroup);
  }
  dom.variable.value = 'wind_gust_max'; // the spec's motivating example
}

function init() {
  initTheme();

  MODELS.forEach((m) => dom.model.append(option(m.id, m.label)));
  dom.model.value = DEFAULT_MODEL;
  dom.model.addEventListener('change', updateModelNote);

  initVariableSelect();
  initDatePickers();
  onWindowChanged();
  updateCacheNote();

  dom.preset.addEventListener('change', applyPreset);

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
  dom.form
    .querySelectorAll('input[name="lookback"]')
    .forEach((box) => box.addEventListener('change', updateWindowNote));

  // Bin count is a pure re-render of already-fetched values.
  dom.bins.addEventListener('change', renderResult);

  dom.exportPngBtn.addEventListener('click', handleExportPNG);
  dom.exportCsvBtn.addEventListener('click', handleExportCSV);

  dom.clearCacheBtn.addEventListener('click', () => {
    const removed = cache.clear();
    updateCacheNote();
    setStatus(removed ? `Cleared ${removed} cached year${removed === 1 ? '' : 's'}.` : 'Cache was already empty.');
  });

  // Under "auto" the OS can flip out from under us; chart colours must follow.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    updateChipColors();
    if (state.result) renderResult();
  });
}

init();
