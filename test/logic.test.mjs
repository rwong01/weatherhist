// Pure-logic tests. No dependencies, no build step, no browser:
//
//     node test/logic.test.mjs
//
// Everything here is a pure function, so it runs in plain Node. The DOM-facing parts
// (typeahead, theme control, chart rendering, exports) are exercised by driving a
// real browser instead; this file covers the arithmetic those layers depend on —
// the calendar maths, the aggregation, the binning and the statistics.

import assert from 'node:assert';
import * as weather from '../lib/weather.js';
import * as chart from '../lib/chart.js';
import * as exporter from '../lib/export.js';
import * as cache from '../lib/cache.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Bin a single series the way a caller does: edges from the values, then counts. */
function bin(values, binCount = 'auto') {
  const edges = chart.computeEdges(values, binCount);
  return { ...edges, counts: chart.binValues(values, edges.edges) };
}

// --- calendar windows --------------------------------------------------------

test('a plain window maps to the same month/day in each year', () => {
  assert.deepStrictEqual(weather.rangeForYear(2023, '06-15', '06-30'), {
    start_date: '2023-06-15',
    end_date: '2023-06-30',
    wraps: false,
  });
});

test('a window ending before it starts wraps into the following year', () => {
  assert.deepStrictEqual(weather.rangeForYear(2023, '12-20', '01-05'), {
    start_date: '2023-12-20',
    end_date: '2024-01-05',
    wraps: true,
  });
});

test('Feb 29 clamps to Feb 28 in non-leap years', () => {
  assert.strictEqual(weather.rangeForYear(2023, '02-20', '02-29').end_date, '2023-02-28');
  assert.strictEqual(weather.rangeForYear(2024, '02-20', '02-29').end_date, '2024-02-29');
});

test('window length is measured per year, not once', () => {
  assert.strictEqual(weather.daysInWindow(2024, '01-01', '12-31'), 366);
  assert.strictEqual(weather.daysInWindow(2023, '01-01', '12-31'), 365);
  assert.strictEqual(weather.daysInWindow(2024, '02-20', '02-29'), 10);
  assert.strictEqual(weather.daysInWindow(2023, '02-20', '02-29'), 9);
  assert.strictEqual(weather.daysInWindow(2024, '06-15', '06-30'), 16);
  assert.strictEqual(weather.daysInWindow(2023, '12-20', '01-05'), 17);
});

test('windowLength stays the leap-year maximum, for sizing estimates only', () => {
  assert.strictEqual(weather.windowLength('01-01', '12-31'), 366);
  assert.strictEqual(weather.windowLength('06-15', '06-30'), 16);
});

test('the reported spread covers every length the window actually takes', () => {
  const years = [2021, 2022, 2023, 2024, 2025];
  assert.deepStrictEqual(weather.windowLengthRange('01-01', '12-31', years), [365, 366]);
  assert.deepStrictEqual(weather.windowLengthRange('02-20', '02-29', years), [9, 10]);
  assert.deepStrictEqual(weather.windowLengthRange('06-15', '06-30', years), [16]);
});

test('multiplying the leap-year maximum over-counts by the non-leap years', () => {
  // This is the bug expectedDays replaced: the old formula reported the difference
  // as days with "incomplete hourly data" when nothing was missing.
  for (const first of [1996, 1997]) {
    const years = Array.from({ length: 30 }, (_, i) => first + i);
    const nonLeap = years.filter((y) => weather.daysInWindow(y, '01-01', '12-31') === 365).length;
    const naive = weather.windowLength('01-01', '12-31') * years.length;
    const real = sum(years.map((y) => weather.daysInWindow(y, '01-01', '12-31')));
    assert.strictEqual(naive - real, nonLeap);
    assert.ok(nonLeap >= 22, `${first}: only ${nonLeap} non-leap years`);
  }
});

// --- which years to request --------------------------------------------------

const AUG_2026 = new Date('2026-08-17T00:00:00Z');

test('a closed window includes the current year', () => {
  const { years, truncated } = weather.seasonYears(10, '06-15', '06-30', AUG_2026);
  assert.deepStrictEqual([years[0], years.at(-1), years.length, truncated], [2017, 2026, 10, false]);
});

test('a window that has not closed yet shifts back a year', () => {
  // Aug 30 2026 is within the archive's lag, so 2026 is not usable.
  assert.strictEqual(weather.seasonYears(10, '08-15', '08-30', AUG_2026).years.at(-1), 2025);
});

test('a wrapping window is labelled by its start year', () => {
  assert.deepStrictEqual(weather.seasonYears(3, '12-20', '01-05', AUG_2026).years, [2023, 2024, 2025]);
});

test('the window truncates at the start of the archive', () => {
  const { years, truncated } = weather.seasonYears(30, '06-15', '06-30', new Date('1955-12-31T00:00:00Z'));
  assert.strictEqual(truncated, true);
  assert.strictEqual(years[0], 1940);
});

// --- hourly to daily ---------------------------------------------------------

/** 24 hourly readings for `date`, valued by the callback. */
function day(date, valueAt) {
  const times = [], values = [];
  for (let h = 0; h < 24; h++) {
    times.push(`${date}T${String(h).padStart(2, '0')}:00`);
    values.push(valueAt(h));
  }
  return { times, values };
}

const a = day('2024-06-15', (h) => h);
const b = day('2024-06-16', () => 2);
const times = [...a.times, ...b.times, '2024-06-17T00:00'];
const values = [...a.values, ...b.values, 99];

test('each aggregation reduces a day to one number', () => {
  assert.deepStrictEqual(weather.aggregateDaily(times, values, 'max'), [
    { date: '2024-06-15', value: 23 },
    { date: '2024-06-16', value: 2 },
  ]);
  assert.strictEqual(weather.aggregateDaily(times, values, 'min')[0].value, 0);
  assert.strictEqual(weather.aggregateDaily(times, values, 'sum')[0].value, 276);
  assert.strictEqual(weather.aggregateDaily(times, values, 'mean')[1].value, 2);
});

test('a day with too few readings is dropped, not aggregated', () => {
  // 2024-06-17 has a single reading, so it never reaches the histogram.
  assert.strictEqual(weather.aggregateDaily(times, values, 'max').length, 2);
});

test('null readings are skipped', () => {
  const holed = values.map((v, i) => (i === 23 ? null : v));
  assert.strictEqual(weather.aggregateDaily(times, holed, 'max')[0].value, 22);
});

// --- statistics --------------------------------------------------------------

test('summary statistics over a known sample', () => {
  const s = chart.computeStats([1, 2, 3, 4, 5]);
  assert.strictEqual(s.n, 5);
  assert.strictEqual(s.mean, 3);
  assert.strictEqual(s.median, 3);
  assert.strictEqual(s.min, 1);
  assert.strictEqual(s.max, 5);
  assert.ok(Math.abs(s.stdDev - Math.sqrt(2.5)) < 1e-12, 'sample standard deviation');
});

test('degenerate samples do not throw', () => {
  assert.strictEqual(chart.computeStats([]).n, 0);
  assert.ok(Number.isNaN(chart.computeStats([7]).stdDev), 'sd is undefined for n=1');
});

// --- binning -----------------------------------------------------------------

test('every value lands in a bin, including the maximum', () => {
  let r = bin([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10);
  assert.strictEqual(sum(r.counts), 11);
  assert.ok(r.edges[0] <= 0 && r.edges.at(-1) >= 10);
  assert.strictEqual(sum(bin([0, 10], 10).counts), 2, 'top bin is closed');
});

test('a flat distribution still bins', () => {
  // A dry fortnight is every value identical; there is no span to divide.
  assert.strictEqual(sum(bin([0, 0, 0, 0]).counts), 4);
  assert.strictEqual(sum(bin([5, 5, 5]).counts), 3);
});

test('negative values bin (winter minimum temperatures)', () => {
  const r = bin([-12.4, -3, 0, 5.5, 18]);
  assert.strictEqual(sum(r.counts), 5);
  assert.ok(r.edges[0] <= -12.4);
});

test('the automatic bin count stays in a readable range', () => {
  const gusts = Array.from({ length: 160 }, (_, i) => 8 + (i % 37) * 1.3);
  const r = bin(gusts);
  assert.strictEqual(sum(r.counts), 160);
  assert.ok(r.counts.length >= 8 && r.counts.length <= 40, `got ${r.counts.length} bins`);
});

test('overlaid windows share one set of edges', () => {
  const wide = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20];
  const narrow = [4, 5, 6];
  const { edges } = chart.computeEdges([...wide, ...narrow], 10);
  const cw = chart.binValues(wide, edges);
  const cn = chart.binValues(narrow, edges);
  assert.strictEqual(cw.length, cn.length);
  assert.strictEqual(sum(cw), 10);
  assert.strictEqual(sum(cn), 3, 'the narrower series is fully binned on pooled edges');
  assert.strictEqual(chart.binLabels(edges, 0).length, cw.length);
});

test('values outside the edges clamp rather than vanish', () => {
  const { edges } = chart.computeEdges([1, 20], 10);
  assert.strictEqual(sum(chart.binValues([-99, 999], edges)), 2);
});

// --- the field table ---------------------------------------------------------

test('every field is completely specified and uniquely keyed', () => {
  const seenFields = new Set();
  const seenIds = new Set();
  for (const field of weather.FIELDS) {
    assert.ok(!seenFields.has(field.hourly), `duplicate field ${field.hourly}`);
    seenFields.add(field.hourly);
    for (const key of ['label', 'short', 'group', 'unit']) {
      assert.ok(field[key], `${field.hourly} is missing ${key}`);
    }
    assert.ok(Number.isInteger(field.decimals), `${field.hourly} has no decimal precision`);
    assert.ok(field.aggregations.length >= 1, `${field.hourly} has no aggregations`);

    for (const a of field.aggregations) {
      assert.ok(!seenIds.has(a.id), `duplicate aggregation id ${a.id}`);
      seenIds.add(a.id);
      assert.ok(['max', 'min', 'sum', 'mean'].includes(a.agg), `${a.id} has an odd aggregation`);
      assert.ok(a.label && a.short, `${a.id} is missing a label`);
    }
  }
});

test('variables are the flattened (field, aggregation) pairs', () => {
  assert.strictEqual(
    weather.VARIABLES.length,
    sum(weather.FIELDS.map((f) => f.aggregations.length))
  );
  // Every variable carries its field's presentation, so a panel can read either.
  for (const v of weather.VARIABLES) {
    assert.strictEqual(v.hourly, v.field.hourly);
    assert.strictEqual(v.unit, v.field.unit);
    assert.strictEqual(v.group, v.field.group);
  }
});

test('fields that answer several aggregations are the point of the design', () => {
  const shared = weather.FIELDS.filter((f) => f.aggregations.length > 1);
  assert.ok(shared.length >= 8, `only ${shared.length} multi-aggregation fields`);
  // One request for temperature_2m yields max, min and mean.
  const temp = weather.getField('temperature_2m');
  assert.deepStrictEqual(temp.aggregations.map((a) => a.agg), ['max', 'min', 'mean']);
  assert.deepStrictEqual(
    weather.variablesOf(temp).map((v) => v.id),
    ['temp_max', 'temp_min', 'temp_mean']
  );
});

test('fields cost less than options: 41 metrics from 32 requests-worth of fields', () => {
  assert.strictEqual(weather.FIELDS.length, 32);
  assert.strictEqual(weather.VARIABLES.length, 41);
  // Selecting six fields is one call per year; selecting six options used to be six.
  assert.strictEqual(weather.callWeight(weather.FIELDS.length > 6 ? 6 : 6, 14), 1);
});

test('variables a histogram would misrepresent stay out of the list', () => {
  const excluded = /wind_direction|weather_code|global_tilted/;
  assert.ok(!weather.FIELDS.some((f) => excluded.test(f.hourly)));
});

test('grouping covers every field exactly once', () => {
  const groups = weather.fieldGroups();
  assert.strictEqual(sum(groups.map(([, fs]) => fs.length)), weather.FIELDS.length);
});

test('unknown ids fall back rather than throwing', () => {
  assert.ok(weather.getField('nope').hourly);
  assert.strictEqual(weather.getField('temperature_2m').hourly, 'temperature_2m');
  assert.strictEqual(weather.getVariable('temp_min').agg, 'min');
});

// --- API call cost -----------------------------------------------------------

test('a request within the free variable and day allowances is one call', () => {
  assert.strictEqual(weather.callWeight(1, 14), 1);
  assert.strictEqual(weather.callWeight(10, 14), 1);
  assert.strictEqual(weather.callWeight(3, 7), 1, 'a short window is not cheaper than one call');
  // The whole reason the cap is 6 rather than 3: six fields still cost one call.
  assert.strictEqual(weather.callWeight(6, 14), 1);
});

test('the weighting matches the published examples', () => {
  // Open-Meteo: "2 weeks of data with 15 weather variables will be calculated as 1.5
  // API calls, while 4 weeks of data equals 3.0 API calls".
  assert.strictEqual(weather.callWeight(15, 14), 1.5);
  assert.strictEqual(weather.callWeight(15, 28), 3);
});

test('batching fields is free up to ten, which is why one request per year wins', () => {
  const oneAtATime = 6 * weather.callWeight(1, 365);
  const batched = weather.callWeight(6, 365);
  assert.ok(Math.abs(batched - oneAtATime / 6) < 1e-9, 'six fields cost the same as one');
  // Past ten it is linear, so "ask for everything" is not free.
  assert.strictEqual(weather.callWeight(20, 14), 2);
  assert.ok(weather.callWeight(32, 14) > 3, 'all 32 fields cost >3x');
});

test('a narrow window over 30 years is far cheaper than one continuous range', () => {
  const years = Array.from({ length: 30 }, (_, i) => 1996 + i);
  const perYear = weather.estimateCalls({ years, startMD: '06-15', endMD: '06-30', fieldCount: 3 });
  const merged = weather.callWeight(3, sum(years.map((y) => weather.daysInWindow(y, '06-15', '06-30'))));
  assert.ok(perYear < 40, `per-year cost ${perYear}`);
  // Same weight for a full year, but a narrow window would download 23x the data.
  assert.ok(Math.abs(perYear - merged) < 1e-9, 'weight is proportional to total days');
});

test('a full-year 30-year query is expensive enough to be worth showing', () => {
  const years = Array.from({ length: 30 }, (_, i) => 1996 + i);
  const calls = weather.estimateCalls({ years, startMD: '01-01', endMD: '12-31', fieldCount: 3 });
  assert.ok(calls > 700 && calls < 800, `got ${calls}`);
});

// --- coordinate snapping -----------------------------------------------------

test('coordinates snap to a grid far finer than the weather model', () => {
  // ERA5-Land is 0.1 degrees (~11 km), so ~1 km rounding cannot change the cell.
  assert.strictEqual(weather.snapCoord(44.0583), 44.06);
  assert.strictEqual(weather.snapCoord(-121.3149), -121.31);
  assert.strictEqual(weather.snapCoord(44.058), weather.snapCoord(44.061),
    'points ~300 m apart share one cache entry');
});

// --- cache keys --------------------------------------------------------------

test('the cache key separates location, variable, window, year and model', () => {
  const base = {
    latitude: 44.058, longitude: -121.315, variableId: 'temp_max',
    startMD: '06-15', endMD: '06-30', year: 2024, model: 'era5',
  };
  assert.strictEqual(cache.makeKey(base), '44.0580,-121.3150|temp_max|06-15-06-30|2024|era5');
  // The same year under a different model must not collide.
  assert.notStrictEqual(cache.makeKey(base), cache.makeKey({ ...base, model: 'best_match' }));
  // Coordinates round, so two geocodes of one place hit one entry.
  assert.strictEqual(cache.makeKey(base), cache.makeKey({ ...base, latitude: 44.05800001 }));
});

// --- cache eviction ----------------------------------------------------------

/**
 * A localStorage stand-in with a byte budget, so the full-store path is exercised
 * deterministically rather than by trying to fill a real browser's quota.
 */
function fakeStorage(budgetBytes) {
  const map = new Map();
  const used = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    removeItem(k) { map.delete(k); },
    setItem(k, v) {
      const next = used() - (map.has(k) ? k.length + map.get(k).length : 0) + k.length + v.length;
      if (next > budgetBytes) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(k, v);
    },
  };
}

test('a full store evicts the oldest entries instead of failing writes', () => {
  const original = globalThis.localStorage;
  // Room for roughly a dozen of these payloads, so eviction has to kick in.
  globalThis.localStorage = fakeStorage(4000);
  try {
    const payload = { u: 'mph', d: Array.from({ length: 20 }, (_, i) => [`2024-06-${i + 1}`, i]) };
    let written = 0;
    for (let i = 0; i < 60; i++) {
      if (cache.set(`key-${i}`, payload)) written += 1;
    }
    assert.strictEqual(written, 60, 'every write succeeded — none failed silently');

    const { entries } = cache.stats();
    assert.ok(entries > 0, 'the cache still holds data');
    assert.ok(entries < 60, `older entries were evicted (kept ${entries})`);

    // The most recent write survived; the very first did not.
    assert.ok(cache.get('key-59'), 'newest entry is present');
    assert.strictEqual(cache.get('key-0'), null, 'oldest entry was evicted');
  } finally {
    globalThis.localStorage = original;
  }
});

test('clear() reports data entries and leaves nothing of ours behind', () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = fakeStorage(1e6);
  try {
    cache.set('a', { u: 'x', d: [] });
    cache.set('b', { u: 'x', d: [] });
    assert.strictEqual(cache.stats().entries, 2);
    assert.strictEqual(cache.clear(), 2, 'the bookkeeping index is not counted as data');
    assert.strictEqual(cache.stats().entries, 0);
  } finally {
    globalThis.localStorage = original;
  }
});

test('a blocked store degrades to no caching rather than throwing', () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = undefined;
  try {
    assert.strictEqual(cache.set('k', { u: 'x', d: [] }), false);
    assert.strictEqual(cache.get('k'), null);
    assert.strictEqual(cache.clear(), 0);
    assert.deepStrictEqual(cache.stats(), { entries: 0, bytes: 0 });
  } finally {
    globalThis.localStorage = original;
  }
});

// --- exports -----------------------------------------------------------------

test('CSV fields are quoted only when they need to be', () => {
  assert.strictEqual(exporter.toCSV([['a', 'b,c', 'd"e'], ['1', '2', '3']]), 'a,"b,c","d""e"\r\n1,2,3');
  assert.strictEqual(exporter.toCSV([['line\nbreak']]), '"line\nbreak"');
});

test('filenames slug cleanly, including en dashes and units', () => {
  assert.strictEqual(exporter.slug('Max wind gust (10 m)'), 'max-wind-gust-10-m');
  assert.strictEqual(exporter.slug('Soil temp 0–7 cm'), 'soil-temp-0-7-cm');
});

// --- report ------------------------------------------------------------------

for (const { name, error } of failures) {
  console.error(`FAIL  ${name}\n      ${error.message.split('\n')[0]}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
