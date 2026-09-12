# Agent entry point

This repository is a Windows browser controller for DeepSeek Harness and other agents that can run local Node.js commands. Read [README.md](README.md) before installation or browser control. The browser extension, Native Messaging host, and local client script work together; copying only `extension/` does not give an agent the command interface.

## Install for a user

First ask which desktop browser the user wants: Edge or Chrome. Ask the user to open `edge://extensions` or `chrome://extensions`, enable Developer mode, load this repository's `extension/` folder as an unpacked extension, and give you its 32-character extension ID. The user must perform the browser permission steps.

From the repository root, run `.\install.ps1 -Browser Edge -ExtensionId '<ID>'` or use `Chrome` for the browser choice. The script builds and registers the current user's Native Messaging host. Then ask the user to reload the extension, use its popup to approve only the needed website origins, open the target page, and click “交给 DSH”.

Verify with `node .\scripts\dsh-edge.mjs status`, then `list`, then `dom <tabId>` for the approved, claimed tab. A loaded extension or a successful build alone does not prove the connection works. The README records that desktop Chrome has an installation path but has not been independently verified end to end in a real Chrome session. Enable this component in only one of Edge or Chrome during a control session because both share the same local transport.

Website access is not permission to save, submit, publish, purchase, or change account settings. Stop at login, CAPTCHA, one-time-code, password, or file-input steps and let the user handle them.

## Use the example agent workspace

Read [examples/agent-workspace/SETUP.md](examples/agent-workspace/SETUP.md). Copy the **contents** of `examples/agent-workspace/` into a separate agent project, not into `extension/`. Confirm that the target agent recognizes that project's `AGENTS.md` and `.agents/skills/` layout; adapt those locations when it does not.

In the separate project, copy `config.example.json` to `config.local.json`; set `controllerScript` to this repository's absolute `scripts/dsh-edge.mjs` path and choose `memoryRoot` and `skillsRoot`. Run `node scripts/site-context.mjs check`. At the start of browser work and after reaching a different target site or page, run `node scripts/site-context.mjs enter '<current-origin-and-path>'`.

With the example defaults, the separate agent project owns:

```text
<agent-project>/
  AGENTS.md
  config.local.json
  .state/active-site.json
  memory/sites/<site-key>/summary.md
  memory/sites/<site-key>/pages/<page-key>.md
  .agents/skills/site-workflow-router/SKILL.md
  .agents/skills/site-<site-key>/SKILL.md
```

The router script computes these paths, reads matching Memory, and writes only `.state/active-site.json`. It does **not** create site Memory or site Skills. The sample Memory and Skill files describe a synthetic test page, not a real website. For a new site, use current `guide <tabId>` output and verified task results to write a compact Memory map. Create or materially update a site Skill only after `advise` recommends `ask_user_before_skill` and the user explicitly agrees to that specific workflow. Never store credentials, tokens, dynamic record IDs, or actual form values in Memory or Skills.

## Develop and package

Use the focused checks in README.md. `package.ps1` creates a source ZIP, not a browser-store submission package. Report Edge, Chrome, or third-party-site behavior as verified only when tested in the corresponding real environment.
