# AGENTS.md

Guidance for coding agents that work in this repository.

## Project

A Buzz desktop plugin (plugin API version 1) that adds the agent type
"Hermes". It bundles the Buzz app's Goose runtime and shared ACP client
unchanged, and swaps in this repository's Hermes process adapter. The
README describes the behavior, the install and the limits. Keep the README
true when you change behavior.

| Path | Purpose |
| --- | --- |
| `plugin/manifest.json` | Plugin manifest and its host grant. |
| `src/index.ts` | The agent type: registration, sessions list, settings tab. |
| `src/hermes.ts` | Replaces buzz-app `bundled/goose/goose.ts`: `hermes acp`, its env, model switch, MCP capability fix. |
| `src/sessions.ts` | Replaces buzz-app `bundled/goose/sessions.ts`: the plugin's own storage key. |
| `src/service-shim.ts` | Replaces buzz-app `features/agents/service.ts` in the bundle: only `fromOwner`. |
| `src/setup.ts` | Model discovery through a throwaway Hermes session. |
| `src/views.ts` | Create and Settings views, with `ctx.react`. |
| `scripts/build-plugin.mjs` | Type check and bundle with the pinned buzz-app clone (`BUZZ_APP_REV`). |
| `scripts/link-toolchain` | Makes the gitignored `buzz-app` link to the clone. |
| `smoke/run.mjs` | End-to-end smoke run: the built plugin against real Hermes. |
| `scripts/check` | All repository checks. The Git hooks call it. |
| `scripts/setup-hooks`, `.githooks/` | Generic hooks and helpers, copied from a template. |
| `.githooks/<hook>.d/` | This repository's own hook checks. |

## Setup and checks

1. Run `scripts/setup-hooks` once after you clone.
2. Set up the buzz-app clone once: README, section "Build".
3. Run tools through mise (`mise exec -- …`, see `mise.toml`).
4. Run `scripts/check --quick` while you work, and `scripts/check` before
   you push. The full check builds the plugin and runs the smoke run with
   real Hermes (README, "Requirements").

Never use `--no-verify`, and never change `core.hooksPath` or other Git
settings. Do not edit the files that come from the hook template:
`.githooks/*` (outside the `*.d/` folders), `.githooks/lib/` and
`scripts/setup-hooks`.

## Plugin rules

- `dist/plugin.js` must stay one ES module with no imports. Use
  `ctx.react` for React. The build's FORBIDDEN list enforces this; never
  shorten it.
- Do not edit the buzz-app clone. A revision change goes through
  `BUZZ_APP_REV`, the README "Compatibility" section and the smoke run.
- The manifest host grant is security-relevant. `scripts/check` requires
  exactly `hermes acp`, `mcp` and `files`. A change to the grant, to
  `ENV`, to `hermesSpawn` or to the permission behavior needs a reason in
  the commit body.
- Do not change the manifest `id` (`sagmans.hermes`), the type id
  (`hermes`) or the storage key (`SESSIONS_KEY`). Saved agents match on
  them. A new storage shape needs a new key suffix and a migration.
- No runtime dependencies. This repository has no package manifest.

## Code rules

- Put each fixed value in a named constant at the top of the file.
- Comments explain why the code exists, not what it does.
- Where code repeats buzz-app code, say so in a comment at those lines and
  keep `NOTICE` true.

## Tests

Do not add a unit test framework. Extend `smoke/run.mjs` for each behavior
change, and make sure that the scenario fails without the change.

## Private data

This repository is public. Never commit names of people, private host
names, real public keys, local home paths, issue tracker links or secrets.
`scripts/check` blocks the common shapes of such data.

## Commits

- Follow `.githooks/GIT_CONVENTION.md` (Conventional Commits with a body).
- Sign and sign off each commit: `git commit -s -S`.
- Make each commit one logical change, and make sure that `scripts/check`
  passes on it.
