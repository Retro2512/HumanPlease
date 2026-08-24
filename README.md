<div align="center">

# HumanPlease

**The shortest known route through support chat to a person.**

[Browse routes](routes) · [Share a route](CONTRIBUTING.md) · [Use with AutoYap](docs/AUTOYAP_INTEGRATION.md)

</div>

---

Support bots make people repeat themselves, choose dead-end topics, and guess which menu
eventually leads to an associate. HumanPlease keeps the routes that already worked so the
next person can take the direct path.

Each route contains only the site, the buttons or generic phrases used before handoff, and
the date it last worked. It never contains a transcript, name, email, phone number, order
number, account detail, cookie, token, or anything said after a person joined.

## One route, in full

```json
{
  "schemaVersion": 1,
  "site": "shop.example.com",
  "locale": "en-CA",
  "startPath": "/support",
  "steps": [
    { "action": "open_chat", "label": "Chat with us" },
    { "action": "select", "label": "Something else" },
    { "action": "send", "value": "live agent" },
    { "action": "wait_for_human" }
  ],
  "verifiedOn": "2026-08-23"
}
```

`fill_required` records that a gate exists without recording what a person entered:

```json
{ "action": "fill_required", "label": "Email" }
```

## Repository layout

- [`routes/`](routes) — accepted routes, grouped by hostname and locale
- [`catalog.json`](catalog.json) — a small generated index for clients
- [`schema/route.schema.json`](schema/route.schema.json) — the public data contract
- [`examples/route.json`](examples/route.json) — a complete example
- [`docs/AUTOYAP_INTEGRATION.md`](docs/AUTOYAP_INTEGRATION.md) — capture, consent, and submission flow

The catalog is available from:

```text
https://raw.githubusercontent.com/Retro2512/HumanPlease/main/catalog.json
```

Run `npm test` and `npm run validate` before opening a pull request. The validator rejects
duplicate routes, unsafe URL parts, unexpected fields, and common forms of personal or
secret data.

## Licence

Code and route data are available under the [MIT License](LICENSE).

