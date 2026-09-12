# Workflow promotion check

The controller's `advise` implements this triage; treat it as a recommendation, not authority to write.

- **Memory map only:** navigation to a directory/search/profile entry in ≤3 stable steps; fields are easy to name and locate. Once the starting page is verified, batch the known path without per-step inspection. Keep a short page map; do not create a separate Skill.
- **Observe more:** fewer than two completed task runs or fewer than two runs with the same verified structure. A visit, `guide` call, or failed attempt is not a completed run.
- **Split at authentication:** a login, CAPTCHA, one-time code, or OCR challenge interrupts the candidate path. Never encode a bypass or ask repeatedly during ordinary navigation; resume after the user completes the challenge.
- **Ask the user before a Skill:** at least two completed stable runs, a meaningful multi-step route, estimated seconds saved per run > estimated Skill read time + 5 seconds, and a proposed Skill within the configured site budget. Ask: “这个网站上的这段已验证流程重复出现，预计每次可节省约 X 秒。是否同意我把不含账号、令牌和业务数据的精简路径写入此网站专属 Skill？” Only write after a clear yes.
- **Shrink or retire:** if the Skill exceeds the token budget, is stale, or its read cost approaches the savings, move detail back to page Memory and keep at most the entry path and stop rules. Different models have different throughput; configure `modelTokensPerSecond` conservatively and reassess after use.

Do not merge knowledge across origins. Within one origin, keep page maps in separate `memory/sites/<site-key>/pages/<page-key>.md` files. A site Skill can include a tiny form outline and point to the matching page Memory, but must not duplicate an entire form or route catalog.
