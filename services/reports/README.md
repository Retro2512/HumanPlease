# Phone report service

This Worker collects structured outcome reports for the phone routes published at
`humanplease.wiki`. It stores day-level records in D1, checks slugs against a generated KV
manifest, and publishes aggregate stats for review through one nightly pull request.

## Endpoints

All JSON responses use `Content-Type: application/json`. Browser requests are accepted from
`https://humanplease.wiki` and `http://localhost` on any port. Other browser origins receive
`403 origin_not_allowed`.

### `POST /v1/reports`

The body must match [`schema/phone-report.schema.json`](../../schema/phone-report.schema.json).
Send the invisible Turnstile response in `X-Turnstile-Token`; it is not part of the stored
report.

```json
{
  "schemaVersion": 1,
  "slug": "best-buy-ca",
  "reachedHuman": true,
  "secondsBucket": "60_300",
  "stepsMatched": false,
  "steps": [
    { "kind": "press", "key": "2" },
    { "kind": "wait" }
  ],
  "clientNonce": "b1c2d3e4f5g6h7i8"
}
```

Success returns `201` with the current route stats. Replaying the same nonce and body within
24 hours returns the cached result with `200`. Reusing a nonce for a different body returns
`409`. A second report from the same daily IP bucket for the same slug replaces the first;
it does not increase the total vote count.

The service accepts duration buckets only. The reported median is the representative value
of the bucket containing the median successful report: 30, 180, 600, or 1200 seconds.

### `GET /v1/stats/:slug`

Returns the current aggregate for a known route:

```json
{
  "slug": "best-buy-ca",
  "up": 128,
  "down": 9,
  "lastConfirmedDay": "2026-09-01",
  "medianSeconds": 180,
  "sampleCount": 128,
  "stale": false
}
```

Routes with no reports have zero counts and `null` dates and medians. A slug absent from the
manifest returns `404`; it is never represented as an unreported known route.

### `POST /v1/stats`

Fetches up to 60 known routes in request order. Duplicate slugs, unknown slugs, extra fields,
and more than 60 entries are rejected.

```json
{ "slugs": ["best-buy-ca", "air-canada-ca"] }
```

```json
{ "stats": [{ "slug": "best-buy-ca", "up": 128, "down": 9, "lastConfirmedDay": "2026-09-01", "medianSeconds": 180, "sampleCount": 128, "stale": false }] }
```

### `GET /healthz`

Returns `{ "ok": true }` when the Worker is running.

## Local development

From a clean checkout with Node 20 or newer:

```sh
npm install
npm run reports:manifest
copy services\reports\.dev.vars.example services\reports\.dev.vars
cd services/reports
npx wrangler d1 migrations apply humanplease-reports --local
npx wrangler kv key put manifest:v1 --binding REPORTS_KV --path ../../data/slug_manifest.json --local
npx wrangler dev
```

On macOS or Linux, use `cp` instead of `copy`. Fill `TURNSTILE_SECRET` and
`IP_HASH_SECRET` in `.dev.vars` before testing report submission. The stats and health
endpoints do not require a Turnstile token. Run all tests from the repository root with
`npm test`; run `npm run reports:typecheck` for a standalone Worker type check.

## Deployment

1. Create the D1 database and KV namespace with `wrangler d1 create humanplease-reports`
   and `wrangler kv namespace create REPORTS_KV`.
2. Replace the placeholder D1 and KV IDs in `wrangler.toml` with the returned IDs.
3. Run `npm run reports:manifest`, then `npm run reports:manifest:upload` from the root.
4. From `services/reports`, run
   `npx wrangler d1 migrations apply humanplease-reports --remote`.
5. Add every secret listed below with `npx wrangler secret put NAME`.
6. Run `npx wrangler deploy` and map the deployed Worker URL to the client configuration.

The scheduled handler runs nightly at 03:17 UTC. It removes IP buckets from reports older
than 30 days, recomputes stats, and creates or updates the `humanplease/route-stats` pull
request against `main`. Alternate numbers need three distinct recent buckets before the job
opens a review issue. The job never changes a published phone number directly.

The GitHub App must be installed only on the target repository and have repository Contents,
Pull requests, and Issues write access. Its installation token is minted by the Worker and is
never stored in the repository.

## Secrets

- `TURNSTILE_SECRET` — Turnstile server-side secret.
- `IP_HASH_SECRET` — high-entropy HMAC root secret used to derive rotating, unlinkable buckets.
- `GITHUB_APP_ID` — GitHub App ID.
- `GITHUB_INSTALLATION_ID` — installation ID for `Retro2512/HumanPlease`.
- `GITHUB_APP_PRIVATE_KEY` — GitHub App private key in PKCS#1 or PKCS#8 PEM form, including markers.

`.dev.vars.example` names these values but leaves them empty. Do not commit `.dev.vars` or a
private key.

## `core.js` client contract

The front end should send reports to the deployed service's `/v1/reports` endpoint with the
JSON shape above and the Turnstile token header. Generate a fresh base64url nonce for a new
report and retain it only while retrying that report. Do not send a raw duration, timestamp,
timezone, session value, contributor value, free text, or Turnstile token in the JSON body.

Page HTML should render the baked `data/route_stats.json` values first. A successful live
stats response may replace those values with the current aggregate. If the API is slow,
unreachable, rejects the request, or returns an unknown slug, leave the baked values in
place. Do not replace them with zeros and do not clear the last-confirmed date.
