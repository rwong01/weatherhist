# WeatherHist: Historical Weather Distribution Tool

## Overview

A free, static web app that lets a user drop in a location (address, zip, city, or
lat/long), pick a historical time window (10, 20, or 30 years), pick a weather
variable, and see a distribution histogram of that variable for a chosen date range
across every year in the window.

Example use case: "Show me the distribution of max daily wind gust for June 15-30
over the past 10 years at this address."

## Tech Stack

- Plain HTML/CSS/JS. No framework, no build step, no bundler.
- Chart.js (via CDN) for rendering histograms.
- Open-Meteo APIs for geocoding and historical weather data (free, no API key required).
- Hosted on Cloudflare Pages (free tier), deployed by connecting this GitHub repo
  directly. No server-side code for v1.

## Core User Flow

1. User enters a location (address, zip, city name, or raw lat/long).
2. App geocodes the input to lat/long using Open-Meteo's geocoding API.
3. User picks a date range within a year (e.g. June 15 - June 30).
4. User picks a lookback window: 10, 20, or 30 years.
5. User picks a weather variable from a dropdown (see Variables section).
6. App fetches hourly data for that date range across every year in the window,
   computes a daily aggregate value for each day (see Aggregation), and renders a
   histogram of the resulting distribution.
7. Chart shows mean, min, max, and sample size (n = number of days).

## APIs

### Geocoding

`GET https://geocoding-api.open-meteo.com/v1/search?name={query}&count=5`

Returns candidate matches with lat/long. If ambiguous (multiple results), show the
user a picker with name/admin1/country for each result.

Raw `lat, lon` input is detected client-side and skips the geocoder entirely.

### Historical Weather

`GET https://archive-api.open-meteo.com/v1/archive`

Params:

- `latitude`, `longitude`
- `start_date`, `end_date` (YYYY-MM-DD) — one request per year in the lookback
  window, since the date range is a fixed day-of-year window (e.g. June 15-30)
  repeated across years, not a single continuous multi-year range.
- `hourly` — the variable for the selected metric
- `timezone=auto` — the archive API resolves the local timezone from lat/long, so
  daily aggregates are grouped by *local* calendar day
- `wind_speed_unit=mph`, `temperature_unit=fahrenheit`, `precipitation_unit=inch` —
  a units toggle can come later; US units are the v1 default since the initial use
  case is US-based.
- `models=era5_seamless` — see Data source below. Not specifying this would take
  Open-Meteo's `best_match` default, which blends in IFS HRES from 2017 onward and
  makes a long lookback window inhomogeneous.

### Data source

All data is ECMWF **ERA5 reanalysis** via Open-Meteo. Pinning `era5_seamless` keeps
one reanalysis family across the whole window: temperature, humidity and soil from
ERA5-Land (~11 km, 1950-), wind, precipitation and radiation from ERA5 (~25 km,
1940-). The alternative `era5` gives uniform ~25 km ERA5 for every variable.

This matters most for the overlay feature: comparing a 10-year window against a
30-year one is only meaningful if both are measured the same way.

### Variables supported in v1

41 options across 7 groups (temperature & humidity, wind, precipitation, pressure &
cloud, solar radiation, soil, evapotranspiration) — every continuous hourly variable
the archive serves for the full 30-year lookback. Each pairs an hourly variable with
a suitable daily aggregation and is grouped into `<optgroup>`s in the dropdown. The
authoritative list lives in `VARIABLES` in `lib/weather.js`.

Deliberately excluded, because a histogram of them would mislead:

- `wind_direction_10m` / `_100m` — circular degrees; the mean of 350° and 10° is
  180°, the opposite direction. Direction needs a wind rose (see non-goals).
- `weather_code` — a categorical WMO code; its numeric spacing is meaningless.
- `global_tilted_irradiance` — requires panel tilt/azimuth parameters.
- ensemble spread variables — require `models=era5_ensemble`.

Display units come from each response's `hourly_units` rather than a hard-coded
table, so changing the unit request parameters can't mislabel an axis.

## Aggregation

For each (year, day) combination, reduce the hourly values to a single daily number
before binning:

- Wind speed / gust: daily max
- Temperature: daily max and daily min are exposed as separate variable options
- Precipitation: daily sum
- Humidity: daily mean

This produces one data point per day per year. The histogram bins these values
across all years in the lookback window.

### Overlaying windows

The three lookback windows are nested and share an end year, so:

- The union of years needed is exactly the largest selected window. It is fetched
  once and the smaller windows are sliced out of it, rather than issuing overlapping
  requests per window.
- Overlaid series share one set of bin edges, computed over their pooled values.
- Overlaid series are plotted as **% of days**, not raw counts — the 30-year window
  contains the 10-year one, so counts would make it taller everywhere and the shapes
  incomparable. A single window still plots as a plain count of days.
- Series colours are categorical slots 1-3, validated for colourblind separation
  against both the light and dark surfaces.

### Edge cases

- **Leap days.** A start/end day that doesn't exist in a given year (Feb 29) is
  clamped to the last valid day of that month for that year's request.
- **Ranges that wrap the new year.** Dec 20 - Jan 5 is fetched as one continuous
  request per season (`YYYY-12-20` → `YYYY+1-01-05`) and labeled by its start year.
- **Archive lag.** The ERA5 archive trails real time by roughly 5 days, so the most
  recent year is only included once its window has fully closed; otherwise the
  window shifts back a year.

## Caching Strategy (v1: client-side only)

- Cache every fetched result in `localStorage`, keyed by
  `{lat},{long}|{variable}|{startMonthDay}-{endMonthDay}|{year}`.
  Keys are **per year** rather than per lookback window so that going from 10 to 30
  years only fetches the 20 years that aren't already cached, and so overlaid windows
  share the years they have in common.
  Each entry stores `{ u: unit, d: [[date, value], ...] }`. The prefix carries a
  schema version (`weatherhist:v2:`), bumped when the stored shape or the pinned
  model changes.
- Before fetching, check cache first. On cache hit, skip the API call entirely.
- Store the raw per-day aggregated values (not just the chart), so switching bin
  size or chart style later doesn't require a re-fetch.
- No expiration needed for v1 since historical data doesn't change. A manual
  "clear cache" button is provided for testing/debugging.
- Coordinates are rounded to 4 decimals (~11 m) in the cache key so that two
  geocodes of the same place hit the same entry.
- If `localStorage` is full or unavailable, writes fail silently and the app keeps
  working without a cache.
- No Cloudflare Worker or KV caching layer in v1. Everything is client-side.

## File Structure

```
/
├── index.html
├── style.css
├── app.js
├── lib/
│   ├── geocode.js   # geocoding API wrapper
│   ├── weather.js   # archive API wrapper + aggregation logic
│   ├── cache.js     # localStorage cache helpers
│   ├── chart.js     # histogram rendering with Chart.js
│   └── export.js    # PNG + CSV download helpers
└── PROJECT_SPEC.md  # this file
```

Modules are small and single-purpose. No framework or state management library;
plain DOM updates are fine given the app's scope.

## UI Requirements

- Single page, no routing.
- Location input with a "search" button, showing a disambiguation list if geocoding
  returns multiple matches.
- Date range picker constrained to month/day (year is irrelevant to the picker).
- Lookback window: **checkboxes** for 10 / 20 / 30 years — any combination can be
  ticked to overlay up to three windows on one chart. Each shows the concrete years
  it covers as subtext, recomputed when the date range changes.
- Date range quick-select for "Full year (Jan 1 - Dec 31)"; hand-editing the
  month/day pickers drops the preset back to "Custom".
- Variable dropdown.
- "Generate" button that triggers the fetch/cache/render flow.
- Loading state with per-year progress while fetching (30 years of data takes a few
  seconds on first load).
- Histogram with axis labels, a mean line per window, and a stats summary (n, mean,
  median, min, max, std dev, 10th/90th percentile) above the chart — a tile grid for
  a single window, a comparison table with colour swatches when several are overlaid.
- Export buttons: chart to PNG (composited onto an opaque background with title and
  attribution) and the data table to CSV (a days/share column pair per window plus a
  provenance block).
- A GitHub link in the bottom-left corner and a Buy Me a Coffee widget in the
  bottom-right, the latter rendered closed (`data-message=""`).
- Mobile-responsive, desktop-first.

## Explicit Non-Goals for v1

- No user accounts or saved queries.
- No server-side caching (Worker/KV).
- No wind direction / wind rose visualization.
- No multi-location comparison in the same chart.
- No commercial use — this app is for personal/non-commercial use per Open-Meteo's
  free tier terms.

## Attribution

A small footer credits Open-Meteo per their CC-BY 4.0 license:
"Weather data by Open-Meteo.com".

## Deployment

Cloudflare Pages, connected directly to this repo:

- Framework preset: **None**
- Build command: *(empty)*
- Build output directory: `/` (project root)

No build step, no environment variables, no server-side code.
