# Deployment security

The repository checks application code, generated pages, and Worker migrations. The host remains a
separate trust boundary.

## Web host

- Run a supported Ubuntu release and install security updates automatically.
- Keep `nginx` at the newest Ubuntu security revision. Do not rely on the upstream version shown in
  the `Server` header; verify the installed package with `apt-cache policy nginx`.
- Include [`deploy/nginx-security.conf`](../deploy/nginx-security.conf) in the HTTPS server block.
- Serve only `press-zero/`. Do not expose the repository root, `.git`, Worker sources, environment
  files, or build tooling.
- Redirect HTTP to HTTPS and allow only `GET` and `HEAD` for the static site.
- After every deploy, run `npm run security:check` and `npm run security:live`.

The static pages use external scripts only. `script-src` must not contain `'unsafe-inline'`. The
single-file download has its own hash-based CSP meta policy.

## Worker

Apply every D1 migration before deploying the Worker. Keep production and local Turnstile widgets
separate, restrict the production widget to `humanplease.wiki`, and retain the configured Cloudflare
rate-limit binding as a second layer in front of the D1 atomic counter.

The GitHub App installation must remain scoped to this repository with only Contents and Pull
requests write access. Rotate its private key and `IP_HASH_SECRET` after any suspected exposure.

## Repository

- Protect `main`: require a pull request, the validation check, one code-owner approval, dismissal of
  stale approvals, and resolution of review threads.
- Block force pushes and branch deletion. Do not let Actions bypass the protection rule.
- Limit the `route-approved` label to maintainers. Route intake creates a pull request and must never
  merge it automatically.
- Keep dependency updates review-only and retain immutable SHA pins for every third-party Action.
