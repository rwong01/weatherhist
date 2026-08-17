# WxLookback: Historical Weather Distribution Tool

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

### Variables supported in v1

| Option                  | Hourly variable        | Aggregation | Unit |
| ----------------------- | ---------------------- | ----------- | ---- |
| Max wind speed          | `wind_speed_10m`       | daily max   | mph  |
| Max wind gust           | `wind_gusts_10m`       | daily max   | mph  |
| Max temperature         | `temperature_2m`       | daily max   | °F   |
| Min temperature         | `temperature_2m`       | daily min   | °F   |
| Total precipitation     | `precipitation`        | daily sum   | in   |
| Mean relative humidity  | `relative_humidity_2m` | daily mean  | %    |

(The spec originally listed the legacy `windspeed_10m` / `windgusts_10m` names.
Open-Meteo still accepts those, but the current names are used here.)

## Aggregation

For each (year, day) combination, reduce the hourly values to a single daily number
before binning:

- Wind speed / gust: daily max
- Temperature: daily max and daily min are exposed as separate variable options
- Precipitation: daily sum
- Humidity: daily mean

This produces one data point per day per year. The histogram bins these values
across all years in the lookback window.

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
  years only fetches the 20 years that aren't already cached.
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
│   └── chart.js     # histogram rendering with Chart.js
└── PROJECT_SPEC.md  # this file
```

Modules are small and single-purpose. No framework or state management library;
plain DOM updates are fine given the app's scope.

## UI Requirements

- Single page, no routing.
- Location input with a "search" button, showing a disambiguation list if geocoding
  returns multiple matches.
- Date range picker constrained to month/day (year is irrelevant to the picker).
- Lookback window: radio group for 10 / 20 / 30 years.
- Variable dropdown.
- "Generate" button that triggers the fetch/cache/render flow.
- Loading state with per-year progress while fetching (30 years of data takes a few
  seconds on first load).
- Histogram with axis labels, mean line, and a stats summary (n, mean, median, min,
  max, std dev) above the chart.
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
