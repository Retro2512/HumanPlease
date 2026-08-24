# AutoYap integration

AutoYap should capture the route while it navigates and discard everything outside the
small route schema.

## Capture boundary

Start recording when the support chat opens. Stop as soon as AutoYap confirms that an
associate joined.

Map actions to these five step types:

| AutoYap action | Route step |
| --- | --- |
| Open the support widget | `open_chat` with the visible label |
| Choose a quick reply or menu branch | `select` with the visible label |
| Fill a required gate | `fill_required` with the field label only |
| Send a generic handoff request | `send` with the exact generic phrase |
| Enter the queue and wait for handoff | `wait_for_human` |

Do not capture DOM, selectors, transcripts, form values, model context, user intent, case
facts, cookies, headers, or messages after handoff. Keep only the hostname and URL pathname;
drop the query and fragment.

## Consent

Show the prompt only after a confirmed handoff and after the route passes local validation:

> Share this route so the next person gets to a human faster?

Actions: **Share route** and **Not now**.

Do not ask again for the same successful route. A declined route stays local and is not
submitted later.

## Submission

Create a GitHub issue with:

- title: `[route] <hostname> (<locale>)`
- body marker: `<!-- humanplease-route-v1 -->`
- one fenced `json` block containing the route object

The public web fallback is:

```text
https://github.com/Retro2512/HumanPlease/issues/new?template=share-route.yml
```

The intake workflow validates the object, normalizes it, calculates its route ID, rebuilds
the catalog, and opens a pull request. Exact duplicates are closed without creating files.

The extension should submit through a GitHub session the user already chose to use, or open
the pre-filled issue in the browser. HumanPlease does not require or accept a GitHub token
inside the route object.

## Reading routes

Fetch the catalog first:

```text
https://raw.githubusercontent.com/Retro2512/HumanPlease/main/catalog.json
```

Each catalog entry includes a relative `path`. Fetch that file from the same commit or raw
base URL. Match exact host first, then parent domains. Prefer the exact locale, then the
same language, then any remaining route. Treat every route as a hint: if a label is missing
or the widget changed, fall back to normal navigation rather than stopping the run.

