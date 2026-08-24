# Share a route

A useful route is the exact sequence that reached a human associate, with everything about
the person who took it removed.

## Before you submit

Keep:

- the site's hostname and support-page path
- the locale used by the chat
- button and menu labels clicked before handoff
- a short, generic handoff phrase such as `live agent`
- required field labels, never the values entered
- the date the route worked

Remove:

- the complete transcript or any message after handoff
- names, emails, phone numbers, addresses, order or account numbers
- URL queries and fragments
- cookies, tokens, request headers, selectors, page HTML, and screenshots
- free-form case details or notes

## Submit from AutoYap

After AutoYap confirms that a person joined, it can show one prompt:

> Share this route so the next person gets to a human faster?

Choosing **Share route** opens a pre-filled route submission. Nothing is submitted before
that choice. The repository checks the route again and ignores an exact duplicate.

## Submit by hand

1. Copy [`examples/route.json`](examples/route.json).
2. Replace the example values with the route that worked.
3. Run `npm run validate -- path/to/route.json`.
4. Open a pull request, or use the **Share a route** issue form.

Accepted routes are stored at:

```text
routes/<hostname>/<locale>/<route-id>.json
```

The route ID is the first 12 characters of a SHA-256 hash of the normalized route. You do
not need to calculate it yourself; the intake script does that.

## Changes to an existing route

Submit the new path as a separate route. Distinct paths can coexist for regional widgets,
experiments, and signed-in or signed-out flows. An exact duplicate is closed automatically.

