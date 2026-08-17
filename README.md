# WeatherHist

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
| `lib/export.js`  | PNG and CSV download helpers                                          |

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
- **Overlaying windows** compares them as a *share of days*, not raw counts. The
  windows are nested — the 30-year window contains the 10-year one — so raw counts
  would make the longer window taller everywhere and the shapes incomparable. All
  series share one set of bin edges computed over their pooled values.
- Overlaid windows are fetched as a single union: ticking 10 + 20 + 30 loads 30
  years once, not 60 requests' worth.

## Data source

Everything comes from **ECMWF ERA5 reanalysis**, served by Open-Meteo's
[Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api).

The app pins `models=era5_seamless` rather than accepting the API's default. That
default is `best_match`, which per Open-Meteo's docs *"combines IFS HRES, ERA5 and
ERA5-Land seamlessly"* — and **IFS HRES only covers 2017 onward**. Blending it in
would make a lookback window inhomogeneous: recent years from a 9 km operational
analysis, older years from 25 km ERA5. A shift in the distribution could then be an
artifact of the model changing rather than the weather changing, which matters most
when overlaying a 10-year window against a 30-year one.

With `era5_seamless` the whole window comes from one reanalysis family:

| Variables                          | Dataset   | Resolution | From |
| ---------------------------------- | --------- | ---------- | ---- |
| Temperature, humidity, soil        | ERA5-Land | ~11 km     | 1950 |
| Wind, precipitation, radiation     | ERA5      | ~25 km     | 1940 |

To use uniform 25 km ERA5 for everything instead, change `MODEL` in
`lib/weather.js` to `'era5'`.

Units are read from each response's `hourly_units` rather than hard-coded, so a
change to the unit request parameters can't silently mislabel an axis.

## Variables

41 options across 7 groups: temperature & humidity, wind, precipitation, pressure &
cloud, solar radiation, soil, and evapotranspiration. Each pairs an hourly variable
with the daily aggregation that suits it (max, min, sum, or mean) — temperature is
offered as max, min, and mean separately.

Four things the archive offers are deliberately **not** in the dropdown, because a
histogram of them would mislead:

- `wind_direction_10m` / `_100m` — circular degrees. Averaging 350° and 10° gives
  180°, the opposite direction. Direction needs a wind rose (a v1 non-goal).
- `weather_code` — a categorical WMO code; its numeric spacing is meaningless.
- `global_tilted_irradiance` — requires panel tilt/azimuth parameters.
- ensemble spread variables — require `models=era5_ensemble`.

## Exports

- **Export chart (PNG)** — the histogram composited onto an opaque background with
  its title, subtitle, and attribution, so the image stands on its own.
- **Export table (CSV)** — one row per bin, a days/share column pair per window, and
  a provenance block (variable, aggregation, coordinates, year spans, source) below
  the data so the header row stays first for spreadsheet imports.

See [`PROJECT_SPEC.md`](PROJECT_SPEC.md) for the full v1 scope and non-goals.

## Attribution

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Personal, non-commercial
use only, per Open-Meteo's free-tier terms.
