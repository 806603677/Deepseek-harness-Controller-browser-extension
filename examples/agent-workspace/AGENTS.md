# Browser workflow contract

Before using the DSH Browser Controller, copy `config.example.json` to `config.local.json` and set the actual controller path, Memory root, Skill root, model speed, and Skill budget. Run `node scripts/site-context.mjs check` before work.

At task start, before loading site/page knowledge, and after reaching a different target page or origin, run `node scripts/site-context.mjs enter <current-http-url>`. Do not rerun it for every intermediate click in a known short route. Load only the returned site and page Memory paths and the matching site Skill. On `siteChanged` or `pageChanged`, discard the previous site's/page's operational assumptions; a same-chat context cannot literally erase old tokens, so use a new agent context for strict separation or high-risk work.

For known, read-only navigation, verify the current origin and entry point once, then use one bounded `sequence` to reach the target. Do not repeatedly re-authenticate, automate CAPTCHA/OCR challenges, or treat a remembered selector as proof of current page state. Stop at an authentication boundary and let the user complete it.

The browser extension supplies `guide` and `advise` evidence, not Memory/Skill writes. First inspect the current site's Memory. If no relevant map exists, perform the task, assess whether a reusable workflow is worthwhile, and ask the user before creating a site Skill. Never infer permission to save, submit, publish, or alter account settings from permission to navigate.

If the page Memory already has a verified form map and the user has approved a matching site Skill, distill only a few stable field names and positions into that Skill within its budget. Do not create or update a Skill just because Memory exists; obtain consent for a new workflow or material change first.
