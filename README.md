<div align="center">

# HumanPlease

**The shortest known route through support chat to a person.**

[Browse routes](routes) · [Share a route](CONTRIBUTING.md) · [Use with AutoYap](docs/AUTOYAP_INTEGRATION.md)

</div>

---

Support bots make people repeat themselves, choose dead-end topics, and guess which menu
eventually leads to an associate. HumanPlease times the routes that worked and keeps the
fastest verified path at the front for the next person.

Each route contains only the site, the buttons or generic phrases used before handoff, the
handoff duration, and the date it last worked. It never contains a transcript, name, email,
phone number, order number, account detail, cookie, token, or anything said after a person
joined.

## One route, in full

```json
{
  "schemaVersion": 2,
  "site": "shop.example.com",
  "locale": "en-CA",
  "startPath": "/support",
  "steps": [
    { "action": "open_chat", "label": "Chat with us" },
    { "action": "select", "label": "Something else" },
    { "action": "send", "value": "live agent" },
    { "action": "wait_for_human" }
  ],
  "verifiedOn": "2026-08-24",
  "handoffSeconds": 94
}
```

`fill_required` records that a gate exists without recording what a person entered:

```json
{ "action": "fill_required", "label": "Email" }
```

## How the fastest route wins

Routes compete within the same hostname and locale. HumanPlease compares their recent
handoff times using the median, 90th percentile, variability, and a confidence penalty for
small samples. A new path needs three confirmed handoffs and a clear lead before it can
replace the current winner. This avoids promoting one lucky run or constantly swapping two
nearly identical routes.

Only the winner is published in the main catalog. Slower paths stay in the archive and keep
collecting timings. If an archived path becomes reliably faster, it moves back to the front
and the old winner is archived. The exact calculation is in [Timing and ranking](docs/TIMING.md).

## Repository layout

- [`routes/`](routes) — the fastest route for each hostname and locale
- [`catalog.json`](catalog.json) — the fast-path index clients should read
- [`archive/`](archive) — slower routes and their separate catalog
- [`schema/submission.schema.json`](schema/submission.schema.json) — the contribution contract
- [`schema/route.schema.json`](schema/route.schema.json) — the ranked storage format
- [`examples/route.json`](examples/route.json) — a complete timing submission
- [`docs/AUTOYAP_INTEGRATION.md`](docs/AUTOYAP_INTEGRATION.md) — capture, consent, and submission flow

The catalog is available from:

```text
https://raw.githubusercontent.com/Retro2512/HumanPlease/main/catalog.json
```

Run `npm test` and `npm run validate` before opening a pull request. The validator rejects
incorrect timing summaries, unsafe URL parts, unexpected fields, and common forms of
personal or secret data. It also checks that each front route still deserves its position.

## Licence

Code and route data are available under the [MIT License](LICENSE).
