// Histogram rendering with Chart.js (loaded globally from a CDN in index.html).
//
// Up to three lookback windows can be plotted together. They are nested (the
// 30-year window contains the 10-year one), so they share one set of bin edges and
// are compared as a share of days rather than as raw counts — otherwise the longer
// window is simply taller everywhere and the shapes can't be compared.

let chartInstance = null;

export function getChart() {
  return chartInstance;
}

// --- statistics --------------------------------------------------------------

/** Linear-interpolated percentile over an already-sorted ascending array. */
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function computeStats(values) {
  const n = values.length;
  if (n === 0) return { n: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  // Sample standard deviation; undefined for a single observation.
  const variance = n > 1 ? values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1) : 0;

  return {
    n,
    mean,
    median: percentile(sorted, 0.5),
    min: sorted[0],
    max: sorted[n - 1],
    stdDev: n > 1 ? Math.sqrt(variance) : NaN,
    p10: percentile(sorted, 0.1),
    p90: percentile(sorted, 0.9),
  };
}

// --- binning -----------------------------------------------------------------

// Round to the *nearest* rung rather than always up: rounding up from 5.85 to 10
// would nearly halve the bin count the caller asked for.
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10];

/** Snap `raw` to the nearest nice number of the form n x 10^k, for readable edges. */
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / magnitude;
  const nice = NICE_STEPS.reduce((best, c) =>
    Math.abs(c - scaled) < Math.abs(best - scaled) ? c : best
  );
  return nice * magnitude;
}

/** Freedman-Diaconis bin count, falling back to sqrt(n) when the IQR is zero. */
function autoBinCount(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const iqr = percentile(sorted, 0.75) - percentile(sorted, 0.25);
  const span = sorted[sorted.length - 1] - sorted[0];

  const suggested =
    iqr > 0 && span > 0
      ? span / ((2 * iqr) / Math.cbrt(values.length))
      : Math.sqrt(values.length);

  return Math.max(8, Math.min(40, Math.ceil(suggested)));
}

/**
 * Equal-width bin edges with human-readable boundaries, derived from the pooled
 * values of every series so overlaid windows share one x-axis.
 * `binCount` may be 'auto'. Returns { edges, width, decimals }.
 */
export function computeEdges(values, binCount = 'auto') {
  if (values.length === 0) return { edges: [], width: 0, decimals: 0 };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const target = binCount === 'auto' ? autoBinCount(values) : Number(binCount);

  // A flat distribution (e.g. a dry two-week window) has no span to divide.
  const width = niceStep(max > min ? (max - min) / target : Math.abs(max) / 10 || 1);
  const start = Math.floor(min / width) * width;
  const count = Math.max(1, Math.ceil((max - start) / width + 1e-9));

  // Enough decimals to distinguish adjacent edges, capped for readability.
  const decimals = Math.max(0, Math.min(2, Math.ceil(-Math.log10(width)) + 1));
  return {
    edges: Array.from({ length: count + 1 }, (_, i) => start + i * width),
    width,
    decimals,
  };
}

/** Count how many of `values` fall in each bin of `edges`. */
export function binValues(values, edges) {
  const count = Math.max(0, edges.length - 1);
  const counts = new Array(count).fill(0);
  if (count === 0) return counts;

  const start = edges[0];
  const width = edges[1] - edges[0];
  for (const v of values) {
    // Values land in [edge, nextEdge); the top bin is closed so `max` is included.
    const i = Math.min(count - 1, Math.max(0, Math.floor((v - start) / width + 1e-9)));
    counts[i] += 1;
  }
  return counts;
}

/** Bin-edge labels shared by the chart axis, the data table, and the CSV export. */
export function binLabels(edges, decimals) {
  return edges.slice(0, -1).map((edge, i) => `${edge.toFixed(decimals)}–${edges[i + 1].toFixed(decimals)}`);
}

// --- rendering ---------------------------------------------------------------

export function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (s.getPropertyValue(name) || '').trim() || fallback;
  return {
    surface: v('--surface-1', '#fcfcfb'),
    seriesColors: [v('--series-1', '#2a78d6'), v('--series-2', '#eb6834'), v('--series-3', '#1baf7a')],
    textPrimary: v('--text-primary', '#0b0b0b'),
    textSecondary: v('--text-secondary', '#52514e'),
    grid: v('--grid', 'rgba(0,0,0,0.08)'),
  };
}

/**
 * Dashed vertical reference line at each series' mean, positioned by value rather
 * than by category index so it can fall between bars. Labels are stacked so two
 * nearby means don't overprint each other.
 */
const meanLinePlugin = {
  id: 'wxMeanLine',
  afterDatasetsDraw(chart, _args, opts) {
    const { lines, edges } = opts || {};
    if (!lines?.length || !edges || edges.length < 2) return;

    const { ctx, chartArea: area, scales } = chart;
    const domainStart = edges[0];
    const domainSpan = edges[edges.length - 1] - domainStart;
    if (!(domainSpan > 0)) return;

    ctx.save();
    lines.forEach(({ value, label, color }, i) => {
      if (value == null || Number.isNaN(value)) return;
      const x = scales.x.left + ((value - domainStart) / domainSpan) * scales.x.width;
      if (x < area.left || x > area.right) return;

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = color;
      ctx.textBaseline = 'top';
      // Flip the label left of the line when it would run off the right edge.
      const flip = x + 6 + ctx.measureText(label).width > area.right;
      ctx.textAlign = flip ? 'right' : 'left';
      ctx.fillText(label, flip ? x - 6 : x + 6, area.top + 2 + i * 14);
    });
    ctx.restore();
  },
};

export function destroyChart() {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
}

/**
 * Render (or re-render) the histogram.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {number[]} options.edges       shared bin edges
 * @param {number} options.decimals      decimals for bin-edge labels
 * @param {Array} options.series         [{ label, counts, stats, color }]
 * @param {string} options.unit
 * @param {string} options.title         short variable name for the x-axis
 * @param {number} options.valueDecimals decimals for values in labels
 */
export function renderHistogram(canvas, { edges, decimals, series, unit, title, valueDecimals }) {
  const theme = readTheme();
  const labels = binLabels(edges, decimals);

  // Nested windows are only comparable as shares; a single window reads better as
  // a plain count of days.
  const asShare = series.length > 1;
  const yTitle = asShare ? '% of days' : 'Number of days';

  destroyChart();

  chartInstance = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label,
        data: asShare ? s.counts.map((c) => (s.stats.n ? (c / s.stats.n) * 100 : 0)) : s.counts,
        rawCounts: s.counts,
        seriesTotal: s.stats.n,
        backgroundColor: s.color,
        // A 1px surface-colored side border leaves a 2px gap between neighbours
        // without shrinking the bars away from the axis.
        borderColor: theme.surface,
        borderWidth: { top: 0, bottom: 0, left: 1, right: 1 },
        borderRadius: 4,
        borderSkipped: 'bottom',
        categoryPercentage: 0.94,
        barPercentage: 1,
      })),
    },
    plugins: [meanLinePlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      layout: { padding: { top: 8 } },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          stacked: false,
          title: {
            display: true,
            text: unit ? `${title} (${unit})` : title,
            color: theme.textSecondary,
            font: { size: 12 },
          },
          grid: { display: false },
          border: { color: theme.grid },
          ticks: {
            color: theme.textSecondary,
            font: { size: 11 },
            maxRotation: 60,
            minRotation: 0,
            autoSkipPadding: 12,
          },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: yTitle, color: theme.textSecondary, font: { size: 12 } },
          grid: { color: theme.grid, drawTicks: false },
          border: { display: false },
          ticks: {
            color: theme.textSecondary,
            font: { size: 11 },
            padding: 8,
            precision: asShare ? undefined : 0,
            callback: (v) => (asShare ? `${v}%` : v),
          },
        },
      },
      plugins: {
        // Identity is never colour-alone: two or more windows always get a legend.
        legend: {
          display: series.length > 1,
          position: 'top',
          align: 'end',
          labels: { color: theme.textSecondary, boxWidth: 12, boxHeight: 12, usePointStyle: false },
        },
        tooltip: {
          backgroundColor: theme.textPrimary,
          padding: 10,
          callbacks: {
            title: (items) => `${items[0].label} ${unit}`.trim(),
            label: (item) => {
              const ds = item.dataset;
              const count = ds.rawCounts[item.dataIndex];
              const pct = ds.seriesTotal ? ((count / ds.seriesTotal) * 100).toFixed(1) : '0';
              const days = `${count} day${count === 1 ? '' : 's'} (${pct}%)`;
              return series.length > 1 ? `${ds.label}: ${days}` : days;
            },
          },
        },
        wxMeanLine: {
          edges,
          lines: series.map((s) => ({
            value: s.stats.mean,
            color: s.color,
            label:
              series.length > 1
                ? `${s.label} mean ${s.stats.mean?.toFixed(valueDecimals ?? decimals)}`
                : `mean ${s.stats.mean?.toFixed(valueDecimals ?? decimals)}`,
          })),
        },
      },
    },
  });

  return chartInstance;
}
