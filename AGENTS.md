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
| `src/hermes.ts` | Replaces buzz-app `bundled/goose/goose.ts`: `hermes acp`, its env, model switch, MCP capability fix, steering, compaction and per-turn usage (`HermesWire`). |
| `src/sessions.ts` | Replaces buzz-app `bundled/goose/sessions.ts`: the plugin's own storage key, and a shared process that stops when idle or full. |
| `src/service-shim.ts` | Replaces buzz-app `features/agents/service.ts` in the bundle: only `fromOwner`. |
| `src/setup.ts` | Model discovery through a throwaway Hermes session, and the provider check: installed, version, gateway state, models. It must not make Hermes start a gateway. |
| `src/recorder.ts`, `src/history.ts` | Shared copies: a tap on an ACP process's JSON-RPC, the local activity record built on it, and the sessions and usage read from that record. Keep their code the same as the other ACP plugin's, except import paths and formatting. Name no harness in them. |
| `src/steer-record.ts` | Files a steer that Hermes took in the turn it steered, which the shared recorder does not model. |
| `src/session-read.ts`, `src/transcript.ts` | Shared copies: the session log, the short-lived `session/load` read with its limits, and a replay's turns with the record's times and steers. Keep their code the same as the other ACP plugin's, except import paths and formatting. |
| `src/activity.tsx` | The Activity tab, from the app's own components: the read first, the record for the running session and as the fallback. |
| `src/provider.tsx` | The app's provider row and dialog: what a setup check found. It shows; it never writes Hermes' setup or starts a gateway. |
| `src/views.tsx` | Create and Settings views, from buzz-app's own components. |
| `src/react-host.ts` | Every `react` import in the bundle: forwards to the app's React. |
| `src/save-footer.tsx` | Puts the Settings Save action in the panel's sticky footer. |
| `scripts/build-plugin.mjs` | Type check and bundle: source from the pinned buzz-app clone (`BUZZ_APP_REV`), every package from this repository's lockfile. |
| `scripts/link-toolchain` | Makes the gitignored `buzz-app` link to the clone. |
| `smoke/run.mjs` | End-to-end smoke run: the built plugin against a stand-in, then real Hermes. |
| `smoke/stub.mjs` | The stand-in `hermes acp`: what real Hermes cannot show on demand. No model runs. |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Every package the build and the bundle use, and their minimum release age. |
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

- `dist/plugin.js` must stay one ES module with no imports. The build's
  FORBIDDEN list and its import check enforce this; never shorten them.
- Every `react` import resolves to `src/react-host.ts`. It forwards to the
  app's React after `bindReact(ctx.react)`, so the bundled buzz-app
  components share the app's hooks. This repository's `react` package must
  have the same version as the app's React; `bindReact` stops on a mismatch.
- The views bundle buzz-app components, not copies, so they look as the
  app's own agents do. The build drops their CSS: the class names are
  content hashes that the app's stylesheet of the same revision already
  has. On each new `BUZZ_APP_REV`, check the New agent dialog and the
  agent's Settings tab live in that app version.
- Do not edit the buzz-app clone, and do not install packages in it. A revision
  change goes through `BUZZ_APP_REV`, the README "Compatibility" section and the
  smoke run.
- The manifest host grant is security-relevant. `scripts/check` requires
  exactly `hermes acp`, `mcp` and `files`. A change to the grant, to
  `ENV`, to `hermesSpawn` or to the permission behavior needs a reason in
  the commit body.
- Do not change the manifest `id` (`sagmans.hermes`), the type id
  (`hermes`) or the storage key (`SESSIONS_KEY`). Saved agents match on
  them. A new storage shape needs a new key suffix and a migration.
- Every package comes from this repository's lockfile, at an exact version. A
  package with a reported security issue is never used. A patch for it has
  priority over the minimum release age. The buzz-app clone gives source only.
- Do not edit `src/recorder.ts` or `src/history.ts` for one harness. Put
  Hermes' needs in `src/hermes.ts` or `src/steer-record.ts`.
- The activity record holds private chat text. Never add a request that holds
  credentials to it, and never send or log it. A change to its shape needs a
  new `ACTIVITY_PREFIX` suffix.
- The type claims no `hooks` and no `protection`: Hermes' tools run in its
  gateway (README, "Limits"). Do not claim them unless Hermes gives a path
  that can enforce them.

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
