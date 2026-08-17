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
- `models` — user-selectable, see Data source below.

### Data source

All data is ECMWF reanalysis via Open-Meteo. Which one is a user choice, exposed as
a Reanalysis dropdown, because it trades per-year accuracy against comparability
over time:

| Option | `models` | Coverage |
| ------ | -------- | -------- |
| Best match (default) | `best_match` | IFS HRES ~9 km from 2017, ERA5/ERA5-Land before |
| ERA5 seamless | `era5_seamless` | ERA5-Land ~11 km (temp/humidity/soil) + ERA5 ~25 km (wind/precip/radiation) |
| ERA5 only | `era5` | ERA5 ~25 km for everything, 1940- |

`best_match` resolves local terrain better and is the most accurate answer for a
single recent year. But its resolution changes at 2017, mid-window, and finer grids
resolve extremes that coarser ones smooth out — so under `best_match` part of any
10-vs-30-year difference is the model rather than the climate. The app surfaces a
warning when an inhomogeneous model is combined with more than one window.

The model is part of the cache key (the same year under a different model is a
different number), is named in the results subtitle, and is recorded in both the PNG
and CSV exports.

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
  against both the light and dark surfaces. `--accent` is a separate, darker step of
  the same blue for interactive chrome: a data mark only needs 3:1 against the
  surface, but a button label sitting on the fill needs 4.5:1.
- The hover tooltip is inverted against the page — a dark panel on light, a light
  panel on dark — and carries its own `--tooltip-bg` / `--tooltip-text` pair rather
  than borrowing a text token, so its background and its glyph colour can never end
  up the same value. Measured from the rendered canvas: 17.4:1 light, 17.7:1 dark.

### Edge cases

- **Leap days.** A start/end day that doesn't exist in a given year (Feb 29) is
  clamped to the last valid day of that month for that year's request. A window that
  spans Feb 29 is therefore a day shorter in non-leap years, so anything comparing
  "days received" against "days expected" sums the per-year lengths rather than
  multiplying one number — otherwise every non-leap year reads as missing a day. The
  date-range note reports the real spread ("365–366 days per year").
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
│   ├── export.js    # PNG + CSV download helpers
│   └── recent.js    # recent locations for this browser session
├── test/
│   └── logic.test.mjs   # dependency-free tests for the pure logic
└── PROJECT_SPEC.md  # this file
```

Modules are small and single-purpose. No framework or state management library;
plain DOM updates are fine given the app's scope.

## UI Requirements

- Single page, no routing.
- The location field remembers the last five places used **in this browser session**
  (`sessionStorage`, so it clears with the tab and never leaves the browser) and
  offers them on focus or click. A tick in the field marks a resolved place — the
  field already shows it, so nothing restates it below.
- Location input with **typeahead suggestions**: an ARIA combobox that queries the
  geocoder as the user types, debounced at 250 ms with a two-character floor and an
  in-memory response cache, aborting any request a later keystroke supersedes. Input
  that parses as `lat, long` skips the geocoder entirely. Arrow keys move an
  `aria-activedescendant` cursor without taking focus off the input; Enter picks the
  active row or runs an explicit search; Escape dismisses. "No matching places" is
  reported inside the list rather than in the status bar. The Search button remains
  as an explicit fallback and auto-selects a lone hit.
- Date range picker constrained to month/day (year is irrelevant to the picker).
- Lookback window: **checkboxes** for 10 / 20 / 30 years — any combination can be
  ticked to overlay up to three windows on one chart. Each shows the concrete years
  it covers as subtext, recomputed when the date range changes. A ticked box takes
  the colour its series will have in the chart, so the selector doubles as a legend.
- A Light / Auto / Dark control in the header. Auto follows `prefers-color-scheme`;
  an explicit choice beats the OS in both directions and persists in `localStorage`
  under a key outside the data-cache namespace, so "Clear cache" doesn't reset it.
- Date range quick-select for "Full year (Jan 1 - Dec 31)"; hand-editing the
  month/day pickers drops the preset back to "Custom".
- Variable **searchable token field**, up to three at a time. The closed field shows
  the selection as tokens (each with its own ×); opening it reveals a search box over
  the grouped list, one tick box per row, so selecting and deselecting happen in the
  same place. Search matches variable and group names. At the cap, unselected rows
  are `aria-disabled` and visibly inert while selected rows still toggle off.
  Keyboard: type to filter, arrows to move, Space/Enter to toggle, Escape to close. Every selected variable renders its own result panel with its own stats,
  histogram, data table and PNG/CSV buttons, all sharing the query's other
  parameters. Variables are never plotted together — different quantities in
  different units — so each panel bins independently. Removing a chip drops its
  panel without refetching the rest.
- "Generate" button that triggers the fetch/cache/render flow.
- Loading state with per-year progress while fetching (30 years of data takes a few
  seconds on first load).
- Histogram with axis labels, a mean line per window, and a stats summary (n, mean,
  median, min, max, std dev, 10th/90th percentile) above the chart — a tile grid for
  a single window, a comparison table with colour swatches when several are overlaid.
- Export buttons: chart to PNG (composited onto an opaque background with title and
  attribution) and the data table to CSV (a days/share column pair per window plus a
  provenance block).
- A footer row carrying a GitHub link at one end and the Buy Me a Coffee button at
  the other, with the attribution between them. Both sit in the page's normal flow
  and scroll with the content rather than floating over it — the widget appends a
  fixed-position button to `<body>`, so `app.js` re-parents it into the footer and
  CSS unpins it. If the widget never loads, the observer gives up and the footer
  simply shows the GitHub link.
- Mobile-responsive, desktop-first. Anything wider than a phone — the bin table and
  the multi-window stats table — scrolls inside its own container; the document
  itself must never scroll horizontally.

### Let the controls do the explaining

Where a control can express its own behaviour, it does, and the prose comes out:

- The lookback control uses real checkboxes with visible tick boxes on rectangular
  cards, not pills — a pill row reads as "pick one". No sentence is needed to say
  multiple can be selected.
- Ticked windows are colour-matched to their chart series, so no text has to explain
  which bars belong to which window.
- The "% of days" y-axis label carries the fact that overlaid windows are normalised.
- Each reanalysis option's dropdown label states its trade-off; the full description
  is the select's tooltip. Only the caution that no label can express — mixing an
  inhomogeneous model with multiple windows — appears as visible prose, and only
  when it applies.
- The location placeholder shows the accepted formats, so the field label is just
  "Location".
- Export buttons are a download icon plus PNG / CSV.

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
