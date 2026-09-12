---
name: site-workflow-router
description: Route repeated browser work through the DSH Browser Controller, current-site Memory, and concise site Skills; use for browser tasks where a known page structure may save navigation time.
---

# Site workflow router

1. Check `config.local.json`; run `node scripts/site-context.mjs enter <current URL>` at task start or before loading page knowledge. Load only returned site/page Memory and matching site Skill. If the site/page changed, drop old assumptions; use a new agent context when strict isolation matters.
2. If a known route is stable, verify the current origin and entry once, then navigate with one bounded `sequence`; do not run the context router on every intermediate page. Stop at login/CAPTCHA/OCR and hand it to the user. Re-enter site context at the destination before a consequential action.
3. If Memory lacks a useful form/entry map, call controller `guide`, finish the current task, and call `advise` with real completed-run evidence. A simple ≤3-step navigation usually needs only a compact Memory map, not a new Skill.
4. Only when `advise` says `ask_user_before_skill`, ask the user and wait for explicit consent before writing a site Skill. If verified page Memory already exists, distill only a few stable field names/positions into an approved matching Skill; Memory existing alone does not authorize Skill creation or material updates. Keep within the configured token budget: short route + form outline + invariant/stop conditions; detailed fields stay in site/page Memory. Never store credentials, tokens, dynamic record IDs, or page values.

For the decision thresholds and consent wording, read [references/flow-criteria.md](references/flow-criteria.md) only when assessing a new workflow candidate.
