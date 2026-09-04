# Data boundary

HumanPlease stores navigation instructions, not conversations.

An accepted route may contain only:

- a hostname
- a URL path without a query or fragment
- a locale
- visible pre-handoff button or field labels
- a generic request for a human associate
- a `wait_for_human` step
- the date the route was verified
- the whole number of seconds from chat opening to confirmed handoff

The schema has no place for a transcript or a form value. Validation also scans every
string for common personal identifiers, credentials, and secret material before a route
can be added. Timing samples contain durations only—no start time, end time, timezone,
session identifier, or contributor identifier.

Saving a phone-route report sends the route slug, outcome, a duration bucket, optional keypad choices,
and an opaque retry nonce. The service
uses the request IP to create keyed, rotating buckets for rate limiting and duplicate-vote prevention;
it does not store the raw IP. Reports and their buckets are deleted after 30 days. Cloudflare processes
the request and Turnstile token as the service provider.

If private information appears in an issue or pull request, remove it from Git history and
the issue timeline rather than editing only the latest file. Repository maintainers can be
contacted through GitHub's private security reporting feature.
