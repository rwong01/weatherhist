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

// --- the variable table ------------------------------------------------------

test('every variable is completely specified and uniquely named', () => {
  const seen = new Set();
  for (const v of weather.VARIABLES) {
    assert.ok(!seen.has(v.id), `duplicate id ${v.id}`);
    seen.add(v.id);
    for (const key of ['group', 'label', 'short', 'hourly', 'agg', 'unit']) {
      assert.ok(v[key], `${v.id} is missing ${key}`);
    }
    assert.ok(['max', 'min', 'sum', 'mean'].includes(v.agg), `${v.id} has an odd aggregation`);
    assert.ok(Number.isInteger(v.decimals), `${v.id} has no decimal precision`);
  }
});

test('variables a histogram would misrepresent stay out of the list', () => {
  const excluded = /wind_direction|weather_code|global_tilted/;
  assert.ok(!weather.VARIABLES.some((v) => excluded.test(v.hourly)));
});

test('grouping covers every variable exactly once', () => {
  const groups = weather.variableGroups();
  assert.strictEqual(sum(groups.map(([, vs]) => vs.length)), weather.VARIABLES.length);
});

test('an unknown variable id falls back rather than throwing', () => {
  assert.ok(weather.getVariable('nope').id);
  assert.strictEqual(weather.getVariable('temp_max').id, 'temp_max');
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
