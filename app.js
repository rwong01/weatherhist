// WeatherHist — wires the DOM controls to geocoding, the archive fetch, and the chart.

import { geocode, parseLatLon, formatPlace, GeocodeError } from './lib/geocode.js';
import {
  fieldGroups,
  getField,
  variablesOf,
  MODELS,
  DEFAULT_MODEL,
  getModel,
  fetchWindows,
  seasonYears,
  daysInMonth,
  formatMD,
  formatMDLabel,
  windowLength,
  windowLengthRange,
  estimateCalls,
  WeatherError,
} from './lib/weather.js';
import * as cache from './lib/cache.js';
import * as recent from './lib/recent.js';
import {
  computeEdges,
  binValues,
  binLabels,
  computeStats,
  renderHistogram,
  destroyAllCharts,
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

// Typeahead pacing. The debounce plus the two-character floor plus the in-memory
// response cache keep a fast typist well inside Open-Meteo's free-tier limits.
const SUGGEST_DEBOUNCE_MS = 250;
const SUGGEST_MIN_CHARS = 2;

/**
 * Up to 10 hourly fields ride in one request for the price of one API call, so the
 * cap is not about quota. Six is where the other costs start to bite: a full-year
 * 30-year query is roughly 2 MB of JSON per field, and the daily aggregates for six
 * fields already take about half of localStorage's ~5 MB.
 */
const MAX_FIELDS = 6;

/** Provenance line for exports — the model materially changes the numbers. */
const sourceLine = (model) => `${ATTRIBUTION} · reanalysis: ${model.id}`;

const el = (id) => document.getElementById(id);

const dom = {
  form: el('controls'),
  locationInput: el('location-input'),
  searchBtn: el('search-btn'),
  geoResults: el('geo-results'),
  geoSpinner: el('geo-spinner'),
  geoOk: el('geo-ok'),
  geoLive: el('geo-live'),
  presetInputs: document.querySelectorAll('input[name="preset"]'),
  startMonth: el('start-month'),
  startDay: el('start-day'),
  endMonth: el('end-month'),
  endDay: el('end-day'),
  windowNote: el('window-note'),
  variableToggle: el('variable-toggle'),
  variableTokens: el('variable-tokens'),
  variablePanel: el('variable-panel'),
  variableSearch: el('variable-search'),
  variableOptions: el('variable-options'),
  resultsList: el('results-list'),
  resultTemplate: el('result-template'),
  model: el('model'),
  modelNote: el('model-note'),
  bins: el('bins'),
  generateBtn: el('generate-btn'),
  clearCacheBtn: el('clear-cache-btn'),
  cacheNote: el('cache-note'),
  status: el('status'),
  themeInputs: document.querySelectorAll('input[name="theme"]'),
};

const state = {
  place: null,
  /** Selected hourly fields, in the order they were added. */
  fieldIds: ['wind_gusts_10m'], // the spec's motivating example
  /** Which aggregation each field's panel is currently showing: fieldId -> variableId. */
  activeVariant: new Map(),
  /** Last successful fetch, kept so bin changes re-render without re-fetching. */
  result: null,
  inFlight: null,
  /** Typeahead: the places on screen, the keyboard cursor, and the live request. */
  suggestions: [],
  activeIndex: -1,
  suggestController: null,
  suggestTimer: null,
};

/**
 * Suggestion responses for this page view, so backspacing doesn't refetch. Bounded
 * because a long typing session would otherwise keep every prefix ever queried:
 * insertion-ordered Map, so deleting the first key evicts the oldest entry.
 */
const SUGGEST_CACHE_MAX = 50;
const suggestCache = new Map();

function cacheSuggestions(key, places) {
  suggestCache.set(key, places);
  while (suggestCache.size > SUGGEST_CACHE_MAX) {
    suggestCache.delete(suggestCache.keys().next().value);
  }
}

// --- small helpers -----------------------------------------------------------

function setStatus(message, kind = 'info') {
  dom.status.hidden = !message;
  dom.status.textContent = message || '';
  dom.status.classList.toggle('error', kind === 'error');
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = String(value);
  o.textContent = label;
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
  syncThemeColorMeta();
}

/**
 * Keep the browser-chrome colour (the address bar on mobile) matched to the page
 * background rather than hard-coding it a second time here, so a future palette
 * tweak in one place can't leave the other stale.
 */
function syncThemeColorMeta() {
  const meta = el('theme-color-meta');
  if (!meta) return;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim();
  if (color) meta.setAttribute('content', color);
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

/**
 * Quick-select presets, keyed by radio value. "custom" has no entry — selecting it
 * is a no-op that just leaves the pickers as they are, which is also why it's what
 * lights back up once a hand edit stops matching any of the others (see
 * `detectPreset`). The day-count ones are relative to today, so they're computed
 * fresh rather than stored, and picking up month/year rollover for free from Date
 * arithmetic — same trick `initDatePickers` uses for the default window.
 */
const PRESET_DEFS = {
  'full-year': () => ({ startMonth: 1, startDay: 1, endMonth: 12, endDay: 31 }),
  'this-month': () => {
    const today = new Date();
    const month = today.getMonth() + 1;
    return { startMonth: month, startDay: 1, endMonth: month, endDay: daysInMonth(month, today.getFullYear()) };
  },
  'next-7': () => nextDaysWindow(7),
  'next-30': () => nextDaysWindow(30),
};

/** Today through today + (days - 1), inclusive — a `days`-long window starting now. */
function nextDaysWindow(days) {
  const start = new Date();
  const end = new Date(start.getTime() + (days - 1) * 86400000);
  return {
    startMonth: start.getMonth() + 1,
    startDay: start.getDate(),
    endMonth: end.getMonth() + 1,
    endDay: end.getDate(),
  };
}

function getPresetValue() {
  return [...dom.presetInputs].find((input) => input.checked)?.value ?? 'custom';
}

function setPresetValue(value) {
  for (const input of dom.presetInputs) input.checked = input.value === value;
}

/** Which preset (if any) the current pickers match; 'custom' when none do. */
function detectPreset(startMD, endMD) {
  for (const [value, def] of Object.entries(PRESET_DEFS)) {
    const p = def();
    if (formatMD(p.startMonth, p.startDay) === startMD && formatMD(p.endMonth, p.endDay) === endMD) {
      return value;
    }
  }
  return 'custom';
}

/** Quick-select presets; "custom" leaves the pickers alone. */
function applyPreset() {
  const def = PRESET_DEFS[getPresetValue()];
  if (!def) return;

  const { startMonth, startDay, endMonth, endDay } = def();
  dom.startMonth.value = String(startMonth);
  fillDays(dom.startMonth, dom.startDay);
  dom.startDay.value = String(startDay);

  dom.endMonth.value = String(endMonth);
  fillDays(dom.endMonth, dom.endDay);
  dom.endDay.value = String(endDay);

  onWindowChanged();
}

/** Hand-editing the pickers means the preset no longer describes them. */
function onWindowChanged() {
  const { startMD, endMD } = currentWindow();
  setPresetValue(detectPreset(startMD, endMD));
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
  const years = lookbacks.length
    ? seasonYears(Math.max(...lookbacks), startMD, endMD).years
    : [];

  // A window covering Feb 29 is a day longer in leap years, so report the real
  // spread over the selected years rather than one number that's wrong for most.
  const lengths = years.length
    ? windowLengthRange(startMD, endMD, years)
    : [windowLength(startMD, endMD)];
  const dayLabel = lengths.length > 1 ? `${lengths[0]}–${lengths[lengths.length - 1]}` : `${lengths[0]}`;

  // Only what the controls can't already show: the window's length in days, the
  // wrap, how much will be fetched, and what a cold fetch costs against the API's
  // quota — a full year over 30 years is ~780 weighted calls, which is worth seeing
  // before pressing Generate rather than after.
  const parts = [`${dayLabel} days per year`];
  if (endMD < startMD) parts.push('wraps into the next year');
  if (years.length) {
    parts.push(`${years.length} years to load`);
    const calls = estimateCalls({
      years,
      startMD,
      endMD,
      fieldCount: Math.max(1, state.fieldIds.length),
    });
    parts.push(`~${Math.ceil(calls)} API calls if not cached`);
  }

  dom.windowNote.textContent = parts.join(' · ');
  syncGenerateEnabled();
  updateChipColors();
  updateModelNote();
}

// --- location ----------------------------------------------------------------

function selectPlace(place) {
  state.place = place;
  recent.add(place);
  closeSuggestions();
  // The field itself is the confirmation; a tick marks it as resolved rather than
  // just typed, so nothing has to restate the place underneath it.
  dom.locationInput.value = formatPlace(place);
  dom.geoOk.hidden = false;
  setStatus('');
}

function closeSuggestions() {
  state.suggestions = [];
  state.activeIndex = -1;
  dom.geoResults.hidden = true;
  dom.geoResults.replaceChildren();
  dom.geoLive.textContent = '';
  dom.locationInput.setAttribute('aria-expanded', 'false');
  dom.locationInput.removeAttribute('aria-activedescendant');
}

/** Move the keyboard cursor; the input keeps focus and points at the active row. */
function setActive(index) {
  const options = dom.geoResults.querySelectorAll('[role="option"]');
  if (!options.length) return;

  state.activeIndex = (index + options.length) % options.length;
  options.forEach((li, i) => {
    const active = i === state.activeIndex;
    li.setAttribute('aria-selected', String(active));
    if (active) {
      dom.locationInput.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    }
  });
}

function openSuggestions(places, heading) {
  state.suggestions = places;
  state.activeIndex = -1;
  dom.geoResults.replaceChildren();

  if (heading && places.length > 0) {
    const li = cell('li', heading, 'geo-heading');
    li.setAttribute('role', 'presentation');
    dom.geoResults.append(li);
  }

  if (places.length === 0) {
    // Reported in the list itself rather than the status bar, where the eye isn't.
    const li = cell('li', 'No matching places', 'geo-empty');
    dom.geoResults.append(li);
  } else {
    places.forEach((place, i) => {
      const li = document.createElement('li');
      li.role = 'option';
      li.id = `geo-option-${i}`;
      li.setAttribute('aria-selected', 'false');
      li.append(
        cell('span', place.name, 'place-name'),
        cell(
          'span',
          [place.admin1, place.country].filter(Boolean).join(', ') +
            ` · ${place.latitude.toFixed(3)}, ${place.longitude.toFixed(3)}`,
          'place-meta'
        )
      );
      // mousedown, not click: it fires before the input's blur closes the list.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectPlace(place);
      });
      dom.geoResults.append(li);
    });
  }

  dom.geoResults.hidden = false;
  dom.locationInput.setAttribute('aria-expanded', 'true');

  // The spinner is aria-hidden, so this is the only cue a screen reader gets that
  // typing (or focusing the field) produced a list.
  const count = `${places.length} location${places.length === 1 ? '' : 's'}`;
  dom.geoLive.textContent =
    places.length === 0 ? 'No matching places' : heading ? `${heading}: ${count}` : `${count} found`;
}

/** Fetch suggestions for `query`, superseding any request already in flight. */
async function loadSuggestions(query) {
  const key = query.toLowerCase();
  if (suggestCache.has(key)) {
    openSuggestions(suggestCache.get(key));
    return;
  }

  state.suggestController?.abort();
  const controller = new AbortController();
  state.suggestController = controller;
  dom.geoSpinner.hidden = false;
  dom.geoLive.textContent = 'Searching for locations…';

  try {
    const places = await geocode(query, { count: 6, signal: controller.signal });
    if (controller.signal.aborted) return;
    cacheSuggestions(key, places);
    openSuggestions(places);
  } catch (err) {
    // A superseded keystroke is not an error worth showing; a real failure just
    // leaves the list closed, and the Search button reports it properly.
    if (err?.name !== 'AbortError') closeSuggestions();
  } finally {
    if (state.suggestController === controller) {
      state.suggestController = null;
      dom.geoSpinner.hidden = true;
    }
  }
}

/** Offer this session's recent places; returns false if there aren't any. */
function showRecent() {
  const places = recent.list();
  if (places.length === 0) {
    closeSuggestions();
    return false;
  }
  openSuggestions(places, 'Recent');
  return true;
}

function onLocationInput() {
  // Typing invalidates the previously chosen place.
  state.place = null;
  dom.geoOk.hidden = true;

  clearTimeout(state.suggestTimer);
  const query = dom.locationInput.value.trim();

  // Nothing to fetch for an empty box or for coordinates, which resolve locally.
  if (query.length < SUGGEST_MIN_CHARS || parseLatLon(query)) {
    state.suggestController?.abort();
    dom.geoSpinner.hidden = true;
    if (query.length === 0) showRecent();
    else closeSuggestions();
    return;
  }

  state.suggestTimer = setTimeout(() => loadSuggestions(query), SUGGEST_DEBOUNCE_MS);
}

/**
 * Focusing the field offers recents rather than re-searching. A field already
 * showing the chosen place isn't a query the user is composing.
 */
function onLocationFocus() {
  const query = dom.locationInput.value.trim();
  if (!query || (state.place && query === formatPlace(state.place))) {
    showRecent();
    return;
  }
  onLocationInput();
}

function onLocationKeydown(event) {
  const open = !dom.geoResults.hidden && state.suggestions.length > 0;

  switch (event.key) {
    case 'ArrowDown':
      if (open) {
        event.preventDefault();
        setActive(state.activeIndex + 1);
      }
      break;
    case 'ArrowUp':
      if (open) {
        event.preventDefault();
        setActive(state.activeIndex - 1);
      }
      break;
    case 'Escape':
      if (!dom.geoResults.hidden) {
        event.preventDefault();
        closeSuggestions();
      }
      break;
    case 'Tab':
      closeSuggestions();
      break;
    case 'Enter':
      event.preventDefault(); // never submit the form from this field
      if (open && state.activeIndex >= 0) selectPlace(state.suggestions[state.activeIndex]);
      else handleSearch();
      break;
    default:
      break;
  }
}

/** Explicit search: same list, but immediate, and a lone hit selects itself. */
async function handleSearch() {
  const query = dom.locationInput.value.trim();
  clearTimeout(state.suggestTimer);
  dom.searchBtn.disabled = true;
  setStatus('Searching for that location…');

  try {
    const places = await geocode(query, { count: 6 });

    if (places.length === 0) {
      setStatus(`No location found for "${query}". Try a city and state, a ZIP code, or raw "lat, long".`, 'error');
      closeSuggestions();
      return;
    }
    if (places.length === 1) {
      selectPlace(places[0]);
      return;
    }

    // Ambiguous — let the user disambiguate rather than guessing the first hit.
    openSuggestions(places);
    setStatus('');
  } catch (err) {
    setStatus(err instanceof GeocodeError ? err.message : 'Something went wrong while geocoding.', 'error');
  } finally {
    dom.searchBtn.disabled = false;
  }
}

// --- variable selection -------------------------------------------------------
//
// Selection is by *hourly field*, not by aggregation: one field answers every
// aggregation derived from it, in the same response. Picking "Temperature (2 m)"
// therefore gets max, min and mean together, and the panel switches between them
// without another request.

/** Compact summary shown in the closed field. */
function renderTokens() {
  dom.variableTokens.replaceChildren();

  if (state.fieldIds.length === 0) {
    dom.variableTokens.append(cell('span', 'Choose a variable…', 'tokens-placeholder'));
    return;
  }

  for (const id of state.fieldIds) {
    const field = getField(id);
    const token = document.createElement('span');
    token.className = 'token';
    token.append(cell('span', field.short));

    // A real button: keyboard reachable, and its own hit target rather than a slice
    // of the field's. Nested buttons are invalid HTML, so the outer control is a div
    // with a button role (see initVariablePicker) instead of a <button>.
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'token-remove';
    remove.textContent = '×';
    remove.title = `Remove ${field.label}`;
    remove.setAttribute('aria-label', `Remove ${field.label}`);
    // Removing must not also toggle the panel.
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleField(id);
    });

    token.append(remove);
    dom.variableTokens.append(token);
  }
}

/** Rebuild the option rows, honouring the current search text and the cap. */
function renderOptions() {
  const query = dom.variableSearch.value.trim().toLowerCase();
  const atCap = state.fieldIds.length >= MAX_FIELDS;
  dom.variableOptions.replaceChildren();

  let shown = 0;
  for (const [group, fields] of fieldGroups()) {
    // Typing a group name ("wind") keeps the whole group, which is how people think.
    const matches = fields.filter(
      (f) =>
        !query ||
        f.label.toLowerCase().includes(query) ||
        group.toLowerCase().includes(query) ||
        f.aggregations.some((a) => a.label.toLowerCase().includes(query))
    );
    if (matches.length === 0) continue;

    dom.variableOptions.append(cell('div', group, 'option-group'));

    for (const field of matches) {
      const selected = state.fieldIds.includes(field.hourly);
      const row = document.createElement('div');
      row.className = 'option-row';
      row.role = 'option';
      row.id = `variable-option-${field.hourly}`;
      row.dataset.id = field.hourly;
      row.setAttribute('aria-selected', String(selected));
      // At the cap the unselected rows are inert; the selected ones still toggle off.
      if (atCap && !selected) row.setAttribute('aria-disabled', 'true');

      const text = document.createElement('span');
      text.className = 'option-text';
      text.append(cell('span', field.label));
      // Say what comes with it, since one pick can yield three histograms.
      if (field.aggregations.length > 1) {
        text.append(cell('span', field.aggregations.map((a) => a.agg).join(' · '), 'option-aggs'));
      }

      row.append(cell('span', '', 'option-box'), text);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault(); // keep focus in the search box
        toggleField(field.hourly);
      });
      dom.variableOptions.append(row);
      shown += 1;
    }
  }

  if (shown === 0) {
    dom.variableOptions.append(cell('div', `No variable matches "${dom.variableSearch.value.trim()}"`, 'option-empty'));
  }
  setActiveOption(0);
}

function optionRows() {
  return [...dom.variableOptions.querySelectorAll('.option-row:not([aria-disabled])')];
}

function setActiveOption(index) {
  const rows = optionRows();
  if (rows.length === 0) {
    dom.variableSearch.removeAttribute('aria-activedescendant');
    return;
  }
  const active = (index + rows.length) % rows.length;
  rows.forEach((row, i) => row.classList.toggle('is-active', i === active));
  const row = rows[active];
  dom.variableSearch.setAttribute('aria-activedescendant', row.id);
  row.scrollIntoView({ block: 'nearest' });
}

function moveActiveOption(delta) {
  const rows = optionRows();
  const current = rows.findIndex((row) => row.classList.contains('is-active'));
  setActiveOption(current + delta);
}

function toggleField(id) {
  const selected = state.fieldIds.includes(id);
  if (selected) {
    state.fieldIds = state.fieldIds.filter((f) => f !== id);
    state.activeVariant.delete(id);
  } else {
    if (state.fieldIds.length >= MAX_FIELDS) return;
    state.fieldIds.push(id);
  }

  renderTokens();
  renderOptions();
  updateWindowNote(); // the estimate counts fields
  // Panels follow the selection immediately: an added field needs data, but a
  // removed one can just go.
  if (selected) renderResult();
}

function openVariablePanel() {
  dom.variablePanel.hidden = false;
  dom.variableToggle.setAttribute('aria-expanded', 'true');
  dom.variableSearch.value = '';
  renderOptions();
  dom.variableSearch.focus();
}

function closeVariablePanel() {
  dom.variablePanel.hidden = true;
  dom.variableToggle.setAttribute('aria-expanded', 'false');
}

function onVariableSearchKeydown(event) {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      moveActiveOption(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveActiveOption(-1);
      break;
    case 'Enter':
    case ' ': {
      const active = dom.variableOptions.querySelector('.option-row.is-active');
      // Space is only a shortcut when it isn't part of what's being typed.
      if (!active || (event.key === ' ' && dom.variableSearch.value.length > 0)) break;
      event.preventDefault();
      toggleField(active.dataset.id);
      break;
    }
    case 'Escape':
      event.preventDefault();
      closeVariablePanel();
      dom.variableToggle.focus();
      break;
    case 'Tab':
      closeVariablePanel();
      break;
    default:
      break;
  }
}

function initVariablePicker() {
  renderTokens();

  const togglePanel = () =>
    dom.variablePanel.hidden ? openVariablePanel() : closeVariablePanel();

  dom.variableToggle.addEventListener('click', togglePanel);
  // role="button" does not get Enter/Space activation for free.
  dom.variableToggle.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    togglePanel();
  });
  dom.variableSearch.addEventListener('input', renderOptions);
  dom.variableSearch.addEventListener('keydown', onVariableSearchKeydown);

  // Escape must work wherever focus is. Clicking an option keeps focus in the search
  // box, but clicking a token's remove button moves it, and Escape then had nothing
  // listening — leaving the panel stuck open over the Generate button.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || dom.variablePanel.hidden) return;
    event.preventDefault();
    closeVariablePanel();
    dom.variableToggle.focus();
  });

  // Clicking anywhere outside the control closes it. Registered in the capture
  // phase on purpose: toggling a row re-renders the list, so in the bubble phase
  // event.target would already be detached and closest() would report "outside".
  document.addEventListener(
    'mousedown',
    (event) => {
      if (dom.variablePanel.hidden) return;
      if (!event.target.closest('.multiselect')) closeVariablePanel();
    },
    true
  );
}

/** Generate needs at least one field and one lookback window. */
function syncGenerateEnabled() {
  dom.generateBtn.disabled =
    state.fieldIds.length === 0 || currentLookbacks().length === 0 || Boolean(state.inFlight);
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
function buildStatTiles(series, variable, unit) {
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
  return dl;
}

/** One row per window when they're overlaid, so the windows compare directly. */
function buildStatTable(allSeries, variable, unit) {
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

    // A window can be fully empty (e.g. it reaches back further than this
    // variable's coverage at this location) while its siblings still have data —
    // say so once instead of a row of unexplained dashes.
    if (series.stats.n === 0) {
      const td = cell('td', 'No data for this window', 'stats-empty');
      td.colSpan = STAT_COLUMNS.length;
      tr.append(td);
    } else {
      for (const [, get, isCount] of STAT_COLUMNS) {
        const value = get(series.stats);
        tr.append(cell('td', isCount ? String(value) : formatNumber(value, variable.decimals)));
      }
    }
    tbody.append(tr);
  }

  table.append(thead, tbody);
  table.prepend(cell('caption', `All values in ${unit} unless noted.`, 'visually-hidden'));
  return table;
}

/** Bin table: one Days/Share column pair per window. */
function fillBinTable(table, edges, decimals, allSeries) {
  const multi = allSeries.length > 1;

  const headRow = document.createElement('tr');
  headRow.append(cell('th', 'Range'));
  for (const series of allSeries) {
    const days = cell('th', multi ? `${series.label} days` : 'Days');
    days.prepend(swatch(series.color));
    headRow.append(days, cell('th', multi ? `${series.label} share` : 'Share'));
  }
  table.querySelector('thead').replaceChildren(headRow);

  table.querySelector('tbody').replaceChildren(
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

/** Bin one variant's windows onto shared edges and return its series. */
function seriesFor(windows, binCountValue) {
  const theme = readTheme();
  const pooled = windows.flatMap((w) => w.points.map((p) => p.value));
  const { edges, decimals } = computeEdges(pooled, binCountValue);

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

  return { edges, decimals, series };
}

/**
 * Build one panel for one field. Every aggregation of the field is already in hand —
 * they came from the same response — so the toggle switches between them without any
 * further work, and the CSV carries all of them.
 */
function buildPanel(dataset, context) {
  const { field, unit } = dataset;
  const usable = dataset.variants.filter((v) => v.windows.some((w) => w.points.length > 0));
  if (usable.length === 0) return null;

  const panel = dom.resultTemplate.content.firstElementChild.cloneNode(true);
  const canvas = panel.querySelector('canvas');
  const toggle = panel.querySelector('.variant-toggle');

  // Remember the choice per field so re-rendering (bin change, theme flip) keeps it.
  const remembered = state.activeVariant.get(field.hourly);
  let active = usable.find((v) => v.variable.id === remembered) || usable[0];

  const binned = new Map(
    usable.map((v) => [v.variable.id, seriesFor(v.windows, dom.bins.value)])
  );

  function paint() {
    const { edges, decimals, series } = binned.get(active.variable.id);
    const variable = active.variable;

    panel.querySelector('.results-title').textContent =
      `${variable.label} · ${formatMDLabel(context.startMD)} – ${formatMDLabel(context.endMD)}`;
    panel.querySelector('.results-subtitle').textContent = [
      formatPlace(context.place),
      series.map((sr) => `${sr.label} (${sr.yearSpan})`).join(' · '),
      context.model.id,
      dataset.fetchedYears === 0
        ? 'all years from cache'
        : `${dataset.fetchedYears} year(s) fetched, ${dataset.cachedYears} from cache`,
    ].join(' · ');

    panel.querySelector('.stats-slot').replaceChildren(
      series.length === 1
        ? buildStatTiles(series[0], variable, unit)
        : buildStatTable(series, variable, unit)
    );
    fillBinTable(panel.querySelector('.bin-table'), edges, decimals, series);

    const summary = series
      .map((sr) => `${sr.label}: ${sr.stats.n} days, mean ${formatNumber(sr.stats.mean, variable.decimals)}`)
      .join('; ');
    canvas.setAttribute(
      'aria-label',
      `Histogram of ${variable.label} in ${unit} for ` +
        `${formatMDLabel(context.startMD)} to ${formatMDLabel(context.endMD)}. ${summary}.`
    );

    for (const button of toggle.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.id === active.variable.id));
    }

    renderHistogram(canvas, {
      edges,
      decimals,
      series,
      unit,
      title: variable.short,
      valueDecimals: variable.decimals,
    });
  }

  // One button per aggregation, only when there's a choice to make.
  if (usable.length > 1) {
    toggle.hidden = false;
    toggle.setAttribute('aria-label', `${field.label} aggregation`);
    for (const variant of usable) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = variant.variable.id;
      // "Max" / "Min" / "Mean" — the field name is already in the title.
      button.textContent = variant.variable.agg === 'sum' ? 'Total' :
        variant.variable.agg[0].toUpperCase() + variant.variable.agg.slice(1);
      button.title = variant.variable.label;
      button.addEventListener('click', () => {
        active = variant;
        state.activeVariant.set(field.hourly, variant.variable.id);
        paint();
      });
      toggle.append(button);
    }
  }

  for (const button of panel.querySelectorAll('[data-export]')) {
    button.addEventListener('click', () =>
      button.dataset.export === 'png'
        ? exportPNG({ canvas, active, unit, context, field })
        : exportCSV({ usable, binned, unit, context, field })
    );
  }

  return { panel, paint };
}

/** Re-derive every panel from `state.result` — no network involved. */
function renderResult() {
  const result = state.result;
  destroyAllCharts();
  dom.resultsList.replaceChildren();
  if (!result) return;

  // Show only the fields still selected, in the order they were chosen.
  const datasets = state.fieldIds
    .map((id) => result.datasets.find((d) => d.field.hourly === id))
    .filter(Boolean);

  const painters = [];
  for (const dataset of datasets) {
    const built = buildPanel(dataset, result);
    if (!built) continue;
    dom.resultsList.append(built.panel);
    painters.push(built.paint);
  }
  // Chart.js measures the canvas, so paint only once each panel is in the document.
  for (const paint of painters) paint();
}

// --- exports -----------------------------------------------------------------

function exportBaseName({ context, variable, field, series }) {
  return [
    'weatherhist',
    slug(variable ? variable.short : field.short),
    `${context.startMD}_${context.endMD}`,
    series.map((sr) => `${sr.lookback}y`).join('-'),
  ].join('_');
}

function exportPNG({ canvas, active, unit, context, field }) {
  const chart = getChart(canvas);
  if (!chart) return;

  const panel = canvas.closest('.results');
  const series = active.windows.map((w) => ({ lookback: w.lookback }));
  downloadChartPNG(chart, {
    title: panel.querySelector('.results-title').textContent,
    subtitle: panel.querySelector('.results-subtitle').textContent,
    footer: sourceLine(context.model),
    theme: readTheme(),
    filename: `${exportBaseName({ context, variable: active.variable, field, series })}.png`,
  });
}

/**
 * One CSV per field, carrying every aggregation that came back with it. Long format
 * — an `aggregation` column rather than a block per aggregation — because each
 * aggregation bins onto its own edges, and one flat table imports cleanly.
 */
function exportCSV({ usable, binned, unit, context, field }) {
  const lookbacks = usable[0].windows.map((w) => w.lookback);

  const header = ['aggregation', 'bin_start', 'bin_end'];
  for (const lookback of lookbacks) header.push(`${lookback}y_days`, `${lookback}y_share_pct`);
  const rows = [header];

  for (const variant of usable) {
    const { edges, decimals, series } = binned.get(variant.variable.id);
    for (let i = 0; i < edges.length - 1; i++) {
      const row = [variant.variable.agg, edges[i].toFixed(decimals), edges[i + 1].toFixed(decimals)];
      for (const sr of series) {
        const count = sr.counts[i];
        row.push(count, sr.stats.n ? ((count / sr.stats.n) * 100).toFixed(1) : '0.0');
      }
      rows.push(row);
    }
  }

  // Provenance below the data, so the header row stays first for spreadsheet imports.
  const series = binned.get(usable[0].variable.id).series;
  rows.push(
    [],
    ['field', `${field.label} (${unit})`],
    ['hourly_variable', field.hourly],
    ['aggregations', usable.map((v) => v.variable.agg).join(' ')],
    ['location', formatPlace(context.place)],
    ['latitude', context.place.latitude],
    ['longitude', context.place.longitude],
    ['date_window', `${context.startMD} to ${context.endMD}`],
    ['reanalysis_model', context.model.id],
    ...series.map((sr) => [`${sr.lookback}y_years`, `${sr.yearSpan} (n=${sr.stats.n} days)`]),
    ['source', sourceLine(context.model)]
  );

  downloadCSV(rows, `${exportBaseName({ context, field, series })}.csv`);
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
  if (state.fieldIds.length === 0) {
    setStatus('Pick at least one variable.', 'error');
    return;
  }

  // A second Generate supersedes the first rather than racing it.
  if (state.inFlight) state.inFlight.abort();
  const controller = new AbortController();
  state.inFlight = controller;

  const { startMD, endMD } = currentWindow();

  dom.generateBtn.disabled = true;
  setStatus('Loading historical data…');

  try {
    const result = await fetchWindows({
      latitude: state.place.latitude,
      longitude: state.place.longitude,
      fieldIds: state.fieldIds,
      startMD,
      endMD,
      lookbacks,
      modelId: dom.model.value,
      signal: controller.signal,
      onProgress: ({ done, total }) => setStatus(`Loading historical data… ${done}/${total} requests`),
    });

    if (controller.signal.aborted) return;

    const usable = result.datasets.filter((d) =>
      d.variants.some((v) => v.windows.some((w) => w.points.length > 0))
    );
    if (usable.length === 0) {
      state.result = null;
      renderResult();
      setStatus('Open-Meteo returned no usable data for that location and window.', 'error');
      return;
    }

    state.result = { ...result, place: state.place, startMD, endMD };
    renderResult();

    const notes = [];
    const empty = result.datasets.filter((d) => !usable.includes(d));
    if (empty.length) {
      notes.push(`No data for ${empty.map((d) => d.field.label).join(', ')} at this location.`);
    }
    for (const dataset of usable) {
      for (const variant of dataset.variants) {
        for (const w of variant.windows) {
          if (w.truncated) notes.push(`Only ${w.years.length} of ${w.lookback} years are in the archive.`);
          if (w.points.length === 0) {
            // Distinct from a partial gap: nothing at all came back for this window,
            // so "incomplete" below would understate it.
            notes.push(`${variant.variable.short} ${w.lookback}y: no usable data in this window.`);
            continue;
          }
          // expectedDays is summed per year by the fetch layer, so a non-leap year
          // never looks like it is missing Feb 29.
          const missing = w.expectedDays - w.points.length;
          if (missing > 0) {
            notes.push(`${variant.variable.short} ${w.lookback}y: ${missing} day(s) had incomplete hourly data.`);
          }
        }
      }
    }
    setStatus([...new Set(notes)].join(' '));
  } catch (err) {
    if (err?.name === 'AbortError') return;
    setStatus(err instanceof WeatherError ? err.message : 'Something went wrong fetching weather data.', 'error');
  } finally {
    if (state.inFlight === controller) {
      state.inFlight = null;
      updateWindowNote(); // re-enables Generate if the selection is still valid
    }
    updateCacheNote();
  }
}

// --- init --------------------------------------------------------------------

/**
 * The Buy Me a Coffee widget appends a fixed-position button to <body>. Move it
 * into the footer so it sits in the page instead of floating over the content. If
 * the widget never loads or renames its element, nothing happens and it keeps its
 * own default rendering.
 */
function dockCoffeeWidget() {
  const slot = el('coffee-slot');
  if (!slot) return;

  const dock = () => {
    const button = document.getElementById('bmc-wbtn');
    if (!button || button.parentElement === slot) return Boolean(button);
    slot.append(button);
    return true;
  };

  if (dock()) return;

  const observer = new MutationObserver(() => {
    if (dock()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true });
  // Stop watching rather than observing forever if the widget never arrives.
  setTimeout(() => observer.disconnect(), 15000);
}

function init() {
  initTheme();
  dockCoffeeWidget();

  MODELS.forEach((m) => dom.model.append(option(m.id, m.label)));
  dom.model.value = DEFAULT_MODEL;
  dom.model.addEventListener('change', updateModelNote);

  initDatePickers();
  initVariablePicker();
  onWindowChanged();
  updateCacheNote();

  for (const input of dom.presetInputs) input.addEventListener('change', applyPreset);

  dom.searchBtn.addEventListener('click', handleSearch);
  dom.locationInput.addEventListener('input', onLocationInput);
  dom.locationInput.addEventListener('keydown', onLocationKeydown);
  // Both focus and click: clicking an already-focused field fires no focus event,
  // and a click on the box should still offer recents.
  dom.locationInput.addEventListener('focus', onLocationFocus);
  dom.locationInput.addEventListener('click', onLocationFocus);
  dom.locationInput.addEventListener('blur', () => setTimeout(closeSuggestions, 0));

  dom.form.addEventListener('submit', handleGenerate);
  dom.form
    .querySelectorAll('input[name="lookback"]')
    .forEach((box) => box.addEventListener('change', updateWindowNote));

  // Bin count is a pure re-render of already-fetched values.
  dom.bins.addEventListener('change', renderResult);

  dom.clearCacheBtn.addEventListener('click', () => {
    const removed = cache.clear();
    updateCacheNote();
    setStatus(removed ? `Cleared ${removed} cached year${removed === 1 ? '' : 's'}.` : 'Cache was already empty.');
  });

  // Under "auto" the OS can flip out from under us; chart colours must follow.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    syncThemeColorMeta();
    updateChipColors();
    if (state.result) renderResult();
  });
}

init();
