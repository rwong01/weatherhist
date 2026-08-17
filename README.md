# WxLookback

A static web app that shows how a weather variable was *distributed* over a slice of
the calendar across the past 10, 20, or 30 years at any location.

> "Show me the distribution of max daily wind gust for June 15–30 over the past
> 10 years at this address."

Pick a place, a month/day range, a lookback window, and a variable; the app pulls
hourly ERA5 reanalysis from [Open-Meteo](https://open-meteo.com/), reduces it to one
value per day, and plots the histogram with mean/median/min/max/σ and percentiles.

## Running locally

There is no build step, but the app uses ES modules, so it needs to be served over
HTTP rather than opened as a `file://` URL:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploying

Cloudflare Pages, connected directly to this repo:

| Setting                | Value        |
| ---------------------- | ------------ |
| Framework preset       | None         |
| Build command          | *(empty)*    |
| Build output directory | `/`          |

No environment variables and no server-side code — Open-Meteo's free endpoints need
no API key.

## How it works

| File             | Responsibility                                                      |
| ---------------- | ------------------------------------------------------------------- |
| `index.html`     | Markup and the Chart.js CDN tag                                       |
| `style.css`      | Theme tokens (light + selected dark mode) and layout                  |
| `app.js`         | Control wiring and render orchestration                               |
| `lib/geocode.js` | Open-Meteo geocoding, plus raw `lat, long` parsing                    |
| `lib/weather.js` | Variable table, season-year math, archive fetch, daily aggregation    |
| `lib/cache.js`   | `localStorage` cache, keyed per location/variable/window/year         |
| `lib/chart.js`   | Binning, summary statistics, histogram rendering                      |

Notes worth knowing:

- **One request per year.** The window is a fixed day-of-year slice repeated across
  years, not a continuous multi-year range. Requests run four at a time.
- **Caching is per year**, so widening 10 → 30 years only fetches the missing 20.
  Historical data doesn't change, so entries never expire; "Clear cache" wipes them.
- **Year-wrapping windows** (Dec 20 – Jan 5) are fetched as one continuous range per
  season and labeled by their start year.
- **The archive lags real time by ~5 days**, so the most recent year is only included
  once its window has fully closed.
- Days with fewer than 20 hourly readings are dropped rather than aggregated, and the
  count of skipped days is reported.

See [`PROJECT_SPEC.md`](PROJECT_SPEC.md) for the full v1 scope and non-goals.

## Attribution

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Personal, non-commercial
use only, per Open-Meteo's free-tier terms.
