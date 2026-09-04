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
- whole seconds from opening the chat to confirmed human handoff

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
that choice. The repository checks the route again and adds the timing to that path's recent
sample window.

## Submit by hand

1. Copy [`examples/route.json`](examples/route.json).
2. Replace the example values with the route that worked.
3. Run `npm run validate -- path/to/route.json`.
4. Paste it into the **Share a route** issue form. A maintainer checks the submission and applies
   `route-approved`; the intake workflow then creates the ranked route pull request.

The selected fastest route is stored at:

```text
routes/<hostname>/<locale>/current.json
```

Other paths remain at `archive/<hostname>/<locale>/<route-id>.json`. You do not need to
calculate the route ID or timing score; the intake script does both.

## Changes to an existing route

Submit every successful run, including another run of an existing path. Repeated timings
make the comparison more reliable. A distinct route starts in the archive when a front
route already exists and must earn promotion with at least three samples.
