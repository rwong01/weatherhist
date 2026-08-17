# WeatherHist

A static web app that shows how a weather variable was *distributed* over a slice of
the calendar across the past 10, 20, or 30 years at any location.

> "Show me the distribution of max daily wind gust for June 15–30 over the past
> 10 years at this address."

Pick a place, a month/day range, one to three lookback windows, and up to six
variables; the
app pulls hourly ECMWF reanalysis from [Open-Meteo](https://open-meteo.com/), reduces
it to one value per day, and plots the histogram with mean/median/min/max/σ and
percentiles. See [Data source](#data-source) for which reanalysis, and why it's a
choice rather than a constant.

## Running locally

There is no build step, but the app uses ES modules, so it needs to be served over
HTTP rather than opened as a `file://` URL:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Tests

```sh
node test/logic.test.mjs
```

No dependencies and no runner to install — the suite covers the pure logic the rest
of the app rests on: the calendar-window maths (including leap days and windows that
wrap the new year), which years get requested, hourly-to-daily aggregation, the
summary statistics, binning and shared bin edges, the field table's integrity, the
API call-weight model, cache-key separation and eviction, and CSV/filename escaping.

The DOM-facing layers — typeahead, theme control, the variable picker, chart
rendering and the exports — are verified by driving a real browser instead, since
what matters there is what actually gets painted.

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
| `lib/geocode.js` | Open-Meteo geocoding (typeahead + explicit), raw `lat, long` parsing  |
| `lib/weather.js` | Field/metric table, season-year math, archive fetch, aggregation       |
| `lib/cache.js`   | `localStorage` cache, keyed per location/variable/window/year/model    |
| `lib/recent.js`  | Recent locations for this browser session (`sessionStorage`)           |
| `lib/chart.js`   | Binning, summary statistics, histogram rendering                       |
| `lib/export.js`  | PNG and CSV download helpers                                          |
| `test/`          | Dependency-free logic tests (`node test/logic.test.mjs`)              |

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

## API usage and caching

Open-Meteo's free tier allows 600 calls/minute, 5,000/hour, **10,000/day** and
300,000/month — and a call is *weighted*, not counted per HTTP request: asking for
more than 10 variables, or more than 2 weeks of data, costs proportionally more
(their example: 2 weeks × 15 variables = 1.5 calls, 4 weeks × 15 = 3.0).

Two consequences shape the request strategy:

- **Up to 10 hourly fields ride along in one request for free.** Every selected field
  is fetched together, one request per year, so six cost the same as one. When this
  was one request per metric, a 3-metric 30-year query took 90 requests / 103
  weighted calls; it is now 30 / 34, and would still be 30 / 34 with six fields.
  Past ten fields the weight is linear, so "ask for everything" is not free — all 32
  fields would cost 3.2×.
- **The day factor is proportional, so merging years saves nothing.** One continuous
  30-year range weighs the same as 30 per-year requests, while downloading ~23× the
  data for a narrow window. Per-year requests are the cheap shape and stay.

This is also why selection is by field rather than by metric: max, min and mean
temperature all read `temperature_2m`, so asking for the field once answers all three
and the panel toggles between them for free. See [Variables](#variables).

**What a query costs is shown before you run it**, in the date-range note, because
the range dominates everything else: Jun 15–30 over 30 years is ~35 calls, but a
*full year* over 30 years is ~780. The free daily quota is about 12 of the latter.

Cached years cost nothing, and the cache is per (location, metric, window, year,
model), so re-running a query, widening the lookback, or swapping one field all fetch
only what's genuinely missing. A field whose max is cached but whose mean is not is
re-requested — but only that field, and it comes back with everything.

Two things make the cache pull its weight:

- **Coordinates snap to ~1 km** before the request. ERA5-Land's grid is ~11 km and
  ERA5's is ~25 km, so this cannot change which cell answers — but it means two
  searches for the same town that differ by a few hundred metres share one entry.
- **A full `localStorage` evicts oldest-first instead of failing.** Previously writes
  failed silently once the ~5 MB store filled, so the cache quietly stopped growing
  and every later query re-fetched — the worst possible behaviour for a quota. A
  handful of full-year queries is enough to fill it.

### Why there's no server-side cache

The free API needs no key, so usage is attributed by IP (their terms mention
collecting IPs "to prevent misuse" and reserving the right to block IP addresses).
Because this app runs entirely in the browser, **every user spends their own quota**.
A Worker proxy would pool all users onto one shared egress quota — for a few dozen
people looking at different locations, cache hits between them would be rare, so it
would trade a per-user 10,000/day for a shared one. That's a regression, not a fix.

A shared cache only starts to pay off if many users query the *same* locations and
windows. If that becomes true, the cheap version is a Worker in front of the archive
using the Cache API keyed on the upstream URL, with a long TTL because historical
data is immutable — no KV needed.

## Location search

The field remembers the **last five locations used in this browser session** and
offers them the moment you focus or click it. They live in `sessionStorage`, so they
vanish when the tab closes and are never shared beyond that browser — switching
`lib/recent.js` to `localStorage` would make them persist across visits instead.

A tick appears in the field once a place is resolved, which is the only confirmation
needed — the field already shows the place, so there's no banner repeating it.

Typing is a typeahead. It queries Open-Meteo's geocoder as you type,
debounced at 250 ms with a two-character minimum, caching responses for the page
view and aborting any request a later keystroke supersedes — a full city name costs
one request, not one per keystroke. Input that looks like `lat, long` resolves
locally without touching the geocoder.

Arrow keys move through suggestions, Enter picks one, Escape dismisses. The Search
button still works as an explicit fallback.

## Data source

All data comes from Open-Meteo's
[Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api),
which serves ECMWF reanalysis. **Which reanalysis is a dropdown in the app**, because
it's a real trade-off rather than a clear win either way:

| Option | `models` | What it is | Best for |
| ------ | -------- | ---------- | -------- |
| **Best match** (default) | `best_match` | IFS HRES (~9 km) from 2017, ERA5/ERA5-Land before | "What was it actually like here?" |
| ERA5 seamless | `era5_seamless` | ERA5-Land (~11 km) for temperature/humidity/soil, ERA5 (~25 km) for wind/precip/radiation | "Has it changed over time?" |
| ERA5 only | `era5` | Every variable from ERA5 at ~25 km, 1940- | Maximum uniformity |

`best_match` is the more accurate answer for any single recent year: a 9 km grid
resolves terrain — valleys, ridgelines, coastlines — that a 25 km cell averages away.

The catch is that the resolution changes at 2017, mid-window. Finer grids resolve
local extremes that coarser ones smooth out, so post-2017 values read systematically
higher at the same real weather. Overlay a 10-year window on a 30-year one under
`best_match` and part of the difference is the model, not the climate. The app warns
about exactly that combination, and the `era5*` options hold one resolution across
the whole window so the comparison is like-for-like.

The chosen model is part of the cache key, appears in the results subtitle, and is
recorded in both exports — the same year under a different model is a different
number, and it should never be ambiguous which one produced a chart.

Units are read from each response's `hourly_units` rather than hard-coded, so a
change to the unit request parameters can't silently mislabel an axis.

## Variables

Selection is by **hourly field**, not by metric, because that is what the archive
actually serves: daily max, min and mean temperature all read `temperature_2m`, and
one request returns the array they're all derived from. So picking
"Temperature (2 m)" gets you all three, and the panel switches between them with a
toggle — instantly, with no further request.

**Up to 6 fields at a time.** The cap isn't about quota: up to ten fields ride in one
request for the price of one call, so six costs exactly what one does. Six is where
the *other* costs bite — a full-year 30-year query is roughly 2 MB of JSON per field,
and six fields' daily aggregates already take about half of `localStorage`'s ~5 MB.

32 fields across 7 groups yield 41 metrics. Each is chosen in a searchable token
field: the closed field shows what's selected, opening it reveals a search box over
the grouped list with a tick box per row, and rows that yield several metrics say so
underneath. Selecting and deselecting are the same gesture in the same place, and
typing narrows the list rather than scrolling it (a group name like "soil" or "wind"
keeps the whole group). At six, unselected rows go visibly inert while the selected
ones still toggle off. Fully keyboard-driven — type to filter, arrows to move, Space
or Enter to toggle, Escape to close.

Every selected field gets its own panel: title, aggregation toggle, stats, histogram,
data table, and its own PNG and CSV buttons — all sharing the query's location, date
window, lookback windows and reanalysis. Removing a token drops that panel without
refetching the others.

Fields are *not* plotted together: they're different quantities in different units,
so each panel bins independently. Only lookback windows share a chart.

Four things the archive offers are deliberately **absent**, because a histogram of
them would mislead:

- `wind_direction_10m` / `_100m` — circular degrees. Averaging 350° and 10° gives
  180°, the opposite direction. Direction needs a wind rose (a v1 non-goal).
- `weather_code` — a categorical WMO code; its numeric spacing is meaningless.
- `global_tilted_irradiance` — requires panel tilt/azimuth parameters.
- ensemble spread variables — require `models=era5_ensemble`.

## Exports

Each panel carries its own pair of buttons, so a six-field query yields six PNGs and
six CSVs. Filenames encode the metric, date window and lookbacks, so they don't
collide.

- **PNG** — the histogram currently on screen, composited onto an opaque background
  with its title, subtitle and attribution, so the image stands on its own.
- **CSV** — **every aggregation of that field in one file**, since they all came from
  the same request. Long format: an `aggregation` column, then `bin_start`/`bin_end`,
  then a days/share column pair per lookback window. Long rather than a block per
  aggregation because each one bins onto its own edges, and one flat table imports
  cleanly. A provenance block (field, hourly variable, aggregations, coordinates,
  year spans, model, source) sits below the data so the header row stays first.

See [`PROJECT_SPEC.md`](PROJECT_SPEC.md) for the full v1 scope and non-goals.

## Attribution

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Personal, non-commercial
use only, per Open-Meteo's free-tier terms.
