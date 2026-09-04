# HumanPlease security audit — 2026-09-03 (updated 2026-09-04)

## Scope

Static site and generated company pages, browser rendering, contact-data build pipeline, scrapers,
phone-report Worker, D1/KV persistence, Turnstile, GitHub App promotion, issue intake, GitHub Actions,
Node/Python dependencies, and the public HTTP/TLS perimeter.

## Findings and remediation

| ID | Severity | Finding | Status |
|---|---|---|---|
| HP-01 | High | 1,272 non-US/Canadian listings silently turned local numbers into `+1` dial links. | Fixed with country-aware dialing and a full-route regression check. |
| HP-02 | High | KV read/modify/write rate limiting was non-atomic and bypassable under concurrency. | Replaced with an atomic, anchored D1 window capped at 10 attempts per IP/hour. The counter stops writing after the cap and cannot double-burst at a wall-clock hour boundary. |
| HP-03 | High | Daily reporter identifiers let one IP appear as three reporters over three days and nominate an alternate number. | Added quarterly reporter identifiers, one active vote per reporter/route, and a 30-day window. The report contract no longer accepts alternate phone numbers. |
| HP-04 | High | Any newly opened issue could trigger a write-capable intake workflow and create branch/PR spam. | Intake now runs only after a maintainer applies `route-approved`; it never merges. Actions are SHA-pinned and time-bounded. |
| HP-05 | High | Scraped URLs reached anchors without a complete scheme/credential/host boundary. | Build-time and runtime allowlists now accept only credential-free public HTTPS hostnames. Active schemes, IP literals, and local/private names fail closed. |
| HP-06 | Medium | Turnstile accepted any successful token without binding it to the production hostname and action. | Bound to the exact hostname and `phone-report` action, capped token length, and added a five-second timeout. |
| HP-07 | Medium | Production CSP allowed inline scripts; the download allowed inline scripts and styles. | All online scripts/styles are external. The single-file build uses computed SHA-256 hashes. Third-party fonts were replaced with pinned, self-hosted subsets. |
| HP-08 | Medium | Single-source phone numbers looked as actionable as official numbers. | Every primary number is classified. Official and independently corroborated numbers remain clickable; 2,481 single-source listings are shown as unverified and cannot be one-click dialed. |
| HP-09 | Medium | Scrapers followed redirects and sitemap URLs without an SSRF boundary or response-size cap. | Added per-scraper host allowlists, public-IP DNS checks, redirect revalidation, HTTPS/port/credential checks, and a 5 MB response limit. |
| HP-10 | Medium | Route paths and labels admitted cross-origin path tricks, encoded separators, markup, and bidirectional controls. | Runtime and JSON-schema validation now reject them; tests cover the bypasses. |
| HP-11 | Medium | Production CORS trusted arbitrary localhost origins. | Production accepts only the exact configured origin and rejects invalid origin configuration. |
| HP-12 | Medium | Data provenance and privacy copy overstated what remained local and which numbers were official. | Copy and privacy documentation now describe Worker/Turnstile processing, rotating keyed network buckets, retention, and trust labels accurately. |
| HP-13 | Low | Literal control bytes in phone parsing broke extension handling and could produce confusing text. | Replaced with escaped regex boundaries, sanitized generated strings, and added Unicode/extension regression tests. |
| HP-14 | Low | Secret files and binary font supply-chain changes lacked repository guards. | Added secret-file ignores/checks, CODEOWNERS, Dependabot coverage, self-hosted font licenses, and pinned font hashes. |
| HP-15 | Medium | Scraped text could begin with spreadsheet formula characters in generated CSV files. | CSV exports now neutralize formula-leading cells; existing exports were rewritten and regression-tested. |
| HP-16 | High | Repeated replacement reports appended rejected history rows, allowing one reporter to amplify D1 storage use. | Replacements now use a conflict-safe in-place upsert, keeping one active row per route and reporter. |
| HP-17 | Medium | Chunked JSON bodies were size-checked only after complete buffering. | Request bodies are now read incrementally and cancelled immediately after 16 KiB; malformed lengths and invalid UTF-8 fail closed. |
| HP-18 | Medium | Alternate-number automation could publish attacker-supplied phone numbers in public issues, while a predictable marker let another issue suppress review. | Removed the public issue automation and its GitHub App permission. |
| HP-19 | Low | Malformed or oversized sitemap URL lists could crash or exhaust a scraper run. | Sitemap entries are origin-allowlisted before use and capped at 100,000 entries. |
| HP-20 | Medium | Originless scripted POST requests could reach report intake if they obtained a valid challenge token. | Every POST and preflight now requires the exact configured production Origin in addition to Turnstile and IP controls. JSON lookalike media types also fail closed. |
| HP-21 | Medium | Python transitive dependencies were resolved dynamically in CI without artifact hashes. | The complete dependency graph is version- and SHA-256-pinned; CI installs it with `--require-hashes`. |
| HP-22 | Medium | Scraper cache filenames used collision-prone SHA-1 URL identifiers. | Cache identifiers now use SHA-256 and no longer read the old SHA-1 namespace. |
| HP-23 | Medium | Validation CI executed dependency lifecycle scripts and did not run the npm vulnerability gate. | CI now installs the locked npm graph with lifecycle scripts disabled and fails on any npm audit finding. |
| HP-24 | Low | Every attacker-controlled validation failure produced a log entry. | Expected 4xx abuse is no longer logged; only service-side failures emit an operational event. |
| HP-25 | Medium | Cached nonce replays bypassed the application rate limiter, allowing unlimited KV reads from one client. | The atomic hourly limit now runs before idempotency-cache lookup, so cached and uncached report attempts share the same cap. |
| HP-26 | Medium | An unused batch-stats POST endpoint performed uncached multi-route D1 reads and could be scripted for resource amplification. | Removed the endpoint and its query/validation surface. |
| HP-27 | High | IPv6 privacy-address rotation let one network evade full-address rate and reporter buckets. | Canonicalized IPv4 identities and grouped IPv6 identities by `/64`, including Cloudflare Pseudo IPv4 recovery, before rate limiting, nonce keys, and vote bucketing. |
| HP-28 | High | Unreviewed Worker aggregates were served directly to route pages, so a lone report could alter user-visible stats before review. | Removed public aggregate endpoints and live client replacement. The site renders only reviewed, baked stats; nightly aggregates require three distinct reporter buckets and still enter through a pull request. |
| HP-29 | Medium | CI and repository metadata still selected Node.js 20 after its March 2026 end-of-life. | Upgraded both workflows and the repository engine floor to the supported Node.js 24 LTS line and added a regression invariant. |
| HP-30 | High | The stats baker trusted `data/route_stats.json` values before inserting them into generated page payloads. | Added strict field, type, range, date, slug, uniqueness, and cross-field validation before baking, with a repository security gate and injection regression test. |
| HP-31 | Medium | The issue-intake workflow had Issues write permission and echoed validation errors derived from issue content in bot-authored comments. | Removed issue-write and automated comment capability; invalid submissions now emit only a fixed status value. |
| HP-32 | Medium | Route intake normalized before validation, silently discarding unsupported root and step fields and overwriting the submitted schema version. | Normalization now preserves the submitted envelope so strict validation rejects hidden fields and schema-version bypasses before any repository write. |
| HP-33 | Low | Repository validation did not forbid symlink or submodule entries that could redirect file reads outside the reviewed tree. | Added an index-mode gate that rejects tracked symlinks and submodules. |
| HP-34 | Medium | After public alternate-number review was disabled, the client and API still collected and retained those unused phone numbers. | Removed the input and contract field, stopped new storage, and added a migration that purges retained values and drops their indexes. |
| HP-35 | High | Scraper DNS checks occurred before `requests` opened a separately resolved connection, leaving a DNS-rebinding race to private addresses. | Replaced the transport with certificate-validated HTTPS that connects directly to the already validated public IP while retaining the original hostname for TLS and HTTP. Redirects are revalidated before another connection, encoded responses are refused, and the unused HTTP dependency was removed. |
| HP-36 | Low | Unsafe scraper allowlist entries were accepted, and an invalid response charset could abort an otherwise bounded request. | Allowlist configuration now rejects malformed, single-label, and IP entries; unknown charsets fall back to UTF-8. |
| HP-37 | Medium | Report intake had no edge burst limiter in front of its global D1 hourly counter. | Added a Cloudflare rate-limit binding capped at 20 requests per network identity per minute; the stricter atomic D1 limit remains in place. |

## Verification

- `npm run security:check`: 43 Node tests, 9 Python scraper security tests, schema validation,
  Worker type checking, 13,911 rendered-route checks, and repository security invariants passed.
- `npm audit --audit-level=low`: no known Node vulnerabilities.
- `pip-audit -r requirements-scrapers.txt`: no known Python vulnerabilities.
- Bandit reported no medium/high Python findings. Semgrep's community security and secret rules
  reported no findings across the Worker, browser code, build tools, scripts, and scrapers.
- The hash-locked Python dependency graph installed successfully in a clean environment; its tests
  and static analysis passed there.
- All three D1 migrations applied to an isolated local database. The production rate-limit SQL was
  executed against local D1 and remained capped after over-limit requests. The replacement-report
  upsert was also executed twice against local D1 and retained exactly one updated report row. The
  third migration retained reporter-bucketed reports while removing legacy weak-bucket rows and the
  alternate-phone column, then rebuilt all required indexes. Public aggregates remained absent at two
  reporter buckets and appeared at three.
- Browser smoke test passed for search, an unverified non-clickable number, an official dial link,
  and the route walkthrough.
- Generated data contains no active URL schemes, credential-bearing URLs, IP-literal/private-host
  links, invalid public email links, bidirectional controls, or NUL bytes.
- Public checks found HTTPS redirection, TLS 1.2/1.3, a valid certificate, blocked unsafe HTTP
  methods, and no exposed `.git`, environment, Worker-source, source-map, or server-status paths.

## Deployment status

The hardened static site and Worker were deployed on 2026-09-04. D1 migrations `0002` and `0003`
were applied, the slug manifest was refreshed, and the Cloudflare rate-limit binding is active at
20 requests per network identity per minute. The production Turnstile widget is restricted to
`humanplease.wiki`; its credential was rotated and the replaced widget was deleted.

The nginx package is at the newest configured Ubuntu security revision. The hardened configuration
passed `nginx -t`, was reloaded atomically with a site backup, hides its version, blocks unsafe
methods and source paths, and serves the restrictive CSP and security headers. `npm run
security:live` passes against the public site and Worker.
