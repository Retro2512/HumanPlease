# press-zero

A front end for the route data in this repo. One job: get someone from "I need to call
this company" to "a person is talking to me" with as few dead ends as possible.

The site build reads source data from `../data/` and the shared route-stats validator from
`../scripts/lib/`.

## Run it

```bash
python -m http.server 8123 --directory press-zero
```

Then open <http://localhost:8123>. No build step, no dependencies, no framework.

## Layout

```
press-zero/
  index.html        search — the only thing on the landing page
  route.html        one company, one route  (route.html?c=<slug>)
  company/<slug>/   generated, crawlable company pages with unique metadata
  companies/        generated alphabetical directory
  about.html        how the data is assembled, and what it does not cover
  assets/
    base.css        the whole design system
    core.js         search + route rendering + the walk-through overlay
  data/
    index.json      search index: name, phone, time-to-human, step count
    stats.json      the three counts on the landing page
    r/<letter>.json full route detail, sharded so a page loads ~200KB not 2MB
  tools/
    build-data.mjs  ../data/*.json  ->  data/
    build-seo-pages.mjs data/ -> crawlable company pages and directory
    bundle.mjs      the whole site  ->  dist/human-please.html (one file)
  dist/
    human-please.html   single-file build, opens straight from disk
```

## Rebuilding

```bash
node press-zero/tools/build-data.mjs && node press-zero/tools/build-seo-pages.mjs && node press-zero/tools/build-sitemap.mjs && node press-zero/tools/bundle.mjs
```

`build-data.mjs` does the work worth reading. The raw scrape stores a phone menu as one
freeform sentence — `"Press 0, then enter zip code, then press 5"` — which is useless to
render. It splits those into atomic actions (`press 0`, `enter zip code`, `press 5`),
types each one, assigns it a duration, merges the result with every phone number and
opening-hours string on file for that company, and picks the best route per company.

## Design

Reference direction: an itemized phone bill crossed with an engineering drawing.
White paper, hairline rules, visible measure rails, tabular numerics.

Four colours, each with exactly one job — nothing is coloured for decoration:

| token    | hex       | job                                             |
| -------- | --------- | ----------------------------------------------- |
| `--blue` | `#1b2aff` | the route, and anything you can act on          |
| `--fire` | `#ff4a1c` | keypad presses, and things that cost you time   |
| `--acid` | `#ffe600` | hold time, and nothing else                     |
| `--leaf` | `#009a58` | reachable right now / confirmed                 |

Type: **Archivo** (variable width axis, used wide for display) for everything readable,
**Martian Mono** for keys, timings and phone numbers.

## Honesty rules baked into the UI

These are deliberate and worth keeping:

- A route with no reported hold time never displays a fast total. It shows the menu
  time and says the hold is unmeasured.
- A company with no recorded menu gets a generic fallback that is labelled, in the box,
  as generic.
- "Confirmed" means two or more written steps from the sources — not that anyone
  verified it today.
- Marking a route wrong actually does something: the warning shows above the steps
  on this device, on this visit and every later one.
- Alternate lines are ranked by time to a person, not by how much data we hold.
- No account, analytics, advertising cookies or free-text reports. Route pages use reviewed, baked totals.
  Saving an answer sends only the structured choices shown; reports and their rotating,
  pseudonymous network buckets are deleted after 30 days.
