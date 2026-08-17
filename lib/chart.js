// Histogram rendering with Chart.js (loaded globally from a CDN in index.html).

let chartInstance = null;

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
 * Bin values into equal-width buckets with human-readable edges.
 * `binCount` may be 'auto'. Returns { edges, counts, width, decimals }.
 */
export function computeBins(values, binCount = 'auto') {
  if (values.length === 0) return { edges: [], counts: [], width: 0, decimals: 0 };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const target = binCount === 'auto' ? autoBinCount(values) : Number(binCount);

  // A flat distribution (e.g. a dry two-week window) has no span to divide.
  const width = niceStep(max > min ? (max - min) / target : Math.abs(max) / 10 || 1);
  const start = Math.floor(min / width) * width;
  const count = Math.max(1, Math.ceil((max - start) / width + 1e-9));

  const edges = Array.from({ length: count + 1 }, (_, i) => start + i * width);
  const counts = new Array(count).fill(0);
  for (const v of values) {
    // Values land in [edge, nextEdge); the top bin is closed so `max` is included.
    const i = Math.min(count - 1, Math.floor((v - start) / width + 1e-9));
    counts[i] += 1;
  }

  // Enough decimals to distinguish adjacent edges, capped for readability.
  const decimals = Math.max(0, Math.min(2, Math.ceil(-Math.log10(width)) + 1));
  return { edges, counts, width, decimals };
}

// --- rendering ---------------------------------------------------------------

function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (s.getPropertyValue(name) || '').trim() || fallback;
  return {
    surface: v('--surface-1', '#fcfcfb'),
    series: v('--series-1', '#2a78d6'),
    textPrimary: v('--text-primary', '#0b0b0b'),
    textSecondary: v('--text-secondary', '#52514e'),
    grid: v('--grid', 'rgba(0,0,0,0.08)'),
  };
}

/**
 * Draws a dashed vertical reference line at the mean, positioned by value rather
 * than by category index so it can fall between bars.
 */
const meanLinePlugin = {
  id: 'wxMeanLine',
  afterDatasetsDraw(chart, _args, opts) {
    const { value, edges, label, color } = opts || {};
    if (value == null || !edges || edges.length < 2) return;

    const { ctx, chartArea: area, scales } = chart;
    const domainStart = edges[0];
    const domainSpan = edges[edges.length - 1] - domainStart;
    if (!(domainSpan > 0)) return;

    const x = scales.x.left + ((value - domainStart) / domainSpan) * scales.x.width;
    if (x < area.left || x > area.right) return;

    ctx.save();
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
    // Flip the label to the left of the line when it would run off the right edge.
    const textWidth = ctx.measureText(label).width;
    const flip = x + 6 + textWidth > area.right;
    ctx.textAlign = flip ? 'right' : 'left';
    ctx.fillText(label, flip ? x - 6 : x + 6, area.top + 2);
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
 * @param {{ bins, stats, unit, title, valueDecimals }} options
 */
export function renderHistogram(canvas, { bins, stats, unit, title, valueDecimals }) {
  const theme = readTheme();
  const { edges, counts, decimals } = bins;
  const fmt = (v) => v.toFixed(decimals);
  const labels = counts.map((_, i) => `${fmt(edges[i])}–${fmt(edges[i + 1])}`);

  destroyChart();

  chartInstance = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Days',
          data: counts,
          backgroundColor: theme.series,
          // A 1px surface-colored side border on each bar leaves a 2px gap between
          // neighbours without shrinking the bars away from the axis.
          borderColor: theme.surface,
          borderWidth: { top: 0, bottom: 0, left: 1, right: 1 },
          // Rounded data-ends; `borderSkipped: 'bottom'` keeps the bar anchored
          // square to the baseline.
          borderRadius: 4,
          borderSkipped: 'bottom',
          categoryPercentage: 1,
          barPercentage: 1,
        },
      ],
    },
    plugins: [meanLinePlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      layout: { padding: { top: 8 } },
      scales: {
        x: {
          title: { display: true, text: unit ? `${title} (${unit})` : title, color: theme.textSecondary, font: { size: 12 } },
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
          title: { display: true, text: 'Number of days', color: theme.textSecondary, font: { size: 12 } },
          grid: { color: theme.grid, drawTicks: false },
          border: { display: false },
          ticks: { color: theme.textSecondary, font: { size: 11 }, precision: 0, padding: 8 },
        },
      },
      plugins: {
        legend: { display: false }, // single series — the heading names it
        tooltip: {
          displayColors: false,
          backgroundColor: theme.textPrimary,
          padding: 10,
          callbacks: {
            title: (items) => `${items[0].label} ${unit}`.trim(),
            label: (item) => {
              const pct = stats.n ? ((item.parsed.y / stats.n) * 100).toFixed(1) : '0';
              return `${item.parsed.y} day${item.parsed.y === 1 ? '' : 's'} (${pct}%)`;
            },
          },
        },
        wxMeanLine: {
          value: stats.mean,
          edges,
          color: theme.textPrimary,
          label: `mean ${stats.mean?.toFixed(valueDecimals ?? decimals)}`,
        },
      },
    },
  });

  return chartInstance;
}
