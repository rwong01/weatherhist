// PNG and CSV export helpers.

/** Trigger a browser download for a Blob. */
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Max wind gust (10 m)" -> "max-wind-gust-10-m" */
export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// --- CSV ---------------------------------------------------------------------

/** RFC 4180 field: quote when the value contains a comma, quote, or newline. */
function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}

export function downloadCSV(rows, filename) {
  // The BOM keeps Excel from mangling the degree sign and en dashes.
  const blob = new Blob(['﻿' + toCSV(rows)], { type: 'text/csv;charset=utf-8' });
  download(blob, filename);
}

// --- PNG ---------------------------------------------------------------------

/**
 * Composite the chart canvas onto an opaque background with its title, subtitle,
 * and the Open-Meteo attribution, so the exported image stands on its own.
 *
 * Chart.js renders at devicePixelRatio, so all padding is expressed in the same
 * device-pixel space to keep the text crisp and proportional.
 */
export function downloadChartPNG(chart, { title, subtitle, footer, theme, filename }) {
  const src = chart.canvas;
  const f = src.width / chart.width || 1; // device px per CSS px

  const padX = Math.round(20 * f);
  const padTop = Math.round((subtitle ? 62 : 40) * f);
  const padBottom = Math.round(30 * f);

  const out = document.createElement('canvas');
  out.width = src.width + padX * 2;
  out.height = src.height + padTop + padBottom;

  const ctx = out.getContext('2d');
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, out.width, out.height);

  const font = (size, weight = '400') =>
    `${weight} ${Math.round(size * f)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  ctx.fillStyle = theme.textPrimary;
  ctx.font = font(16, '600');
  ctx.fillText(title, padX, Math.round(14 * f));

  if (subtitle) {
    ctx.fillStyle = theme.textSecondary;
    ctx.font = font(12);
    ctx.fillText(subtitle, padX, Math.round(38 * f));
  }

  ctx.drawImage(src, padX, padTop);

  if (footer) {
    ctx.fillStyle = theme.textSecondary;
    ctx.font = font(11);
    ctx.fillText(footer, padX, src.height + padTop + Math.round(8 * f));
  }

  out.toBlob((blob) => blob && download(blob, filename), 'image/png');
}
