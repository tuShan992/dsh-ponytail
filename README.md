# dsh-ponytail

[Ponytail](https://github.com/DietrichGebert/ponytail) — "the laziest senior
dev in the room" — as a **DeepSeek Harness (DSH) plugin**.

This is a full DSH port, not just a skill pack. It reproduces the four things
the upstream plugin does:

1. **Always-on ruleset** — the ponytail instructions are injected into the
   system prompt of every turn through DSH's `systemPrompt` service.
2. **Six skills** — `ponytail`, `ponytail-review`, `ponytail-audit`,
   `ponytail-debt`, `ponytail-gain`, `ponytail-help`, served from the DSH skill
   registry as bundled skills (model- and user-invocable).
3. **Mode control** — the `/ponytail` command switches the intensity level
   (`lite` / `full` / `ultra` / `off`) per session, and a standalone
   "stop ponytail" / "normal mode" message turns it off.
4. **One-click sync** — a **Ponytail** page under Settings → 集成 syncs the
   bundled skills from the latest upstream release and refreshes the installed
   copy, so shipping a new upstream version needs no terminal. A background
   check (on by default) polls the registry and shows a red dot beside Settings
   when a newer release exists — click it to sync without opening Settings.

Upstream v5.3.3 (MIT, © Dietrich Gebert). The skill bodies are copied from the
upstream repo; the Cordis glue is DSH-native.

## What you get

| Skill | Purpose |
|---|---|
| `ponytail` | Main mode: before writing code, stop at the first rung that holds — YAGNI → codebase reuse → stdlib → native platform feature → installed dependency → one line → minimum that works. Levels: lite / full / ultra. Never cuts validation, security, accessibility, or data-loss handling. |
| `ponytail-review` | Quality review of a diff: bugs, security, load, missing tests, speed, and what to cut. |
| `ponytail-audit` | The same review over the whole repo, ranked. |
| `ponytail-debt` | Harvest every `shortcut:` comment into a debt ledger. |
| `ponytail-gain` | Measured-impact scoreboard (less code, less cost, more speed). |
| `ponytail-help` | Quick-reference card for all levels and skills. |

## How it maps onto DSH

| ponytail concept | DSH mechanism |
|---|---|
| Ruleset injected every turn | `ctx.systemPrompt.section({ name: "ponytail:ruleset", order: 15000, interpolate: false, text: … })` |
| Six skills | `ctx.skills.registerProvider(() => provider)` reading `skills/*/SKILL.md` |
| `/ponytail [mode]` | `ctx.commands.register({ name: "ponytail", … })` |
| "stop ponytail" / "normal mode" | `ctx.on("agent/pre-step", …)` scanning the entering user messages |
| Per-session mode | `…/ponytail/session-states.json` under the DSH profile dir |
| Sync button + status page | server routes via `ctx.get("webServer").register(...)`; client page via `client.js` + `settings.section` |
| Refresh the installed copy | direct file mirror of `skills/` + runtime files (pnpm does not re-copy unchanged `file:` deps) |

Notes on the DSH-native behaviour:

- **Mode switching is per session**, keyed by `agent.session.id`; two sessions
  can run different levels.
- **`/ponytail` affects the next step**, because the system prompt for a step
  is assembled before the pre-step hook runs — the same caveat the upstream
  OpenCode port documents.
- **Skill invocation**: the six skills are served through DSH's skill registry.
  `/ponytail-help` and `/ponytail-gain` are one-shot cards shown directly;
  `/ponytail-review`, `/ponytail-audit` and `/ponytail-debt` start a model turn
  that runs the matching skill. You can also just ask for a skill by name
  ("use ponytail-review on this diff").

## Commands

| Command | What it does |
|---|---|
| `/ponytail` | Activate full mode for this session. |
| `/ponytail lite\|full\|ultra` | Set the intensity level. |
| `/ponytail off` | Deactivate for this session (also: say "stop ponytail" / "normal mode"). |
| `/ponytail-review` | Review the current changes with the review skill. |
| `/ponytail-audit` | Audit the whole repo with the audit skill. |
| `/ponytail-debt` | Run the debt-ledger skill. |
| `/ponytail-help` | Show the reference card. |
| `/ponytail-gain` | Show the benchmark scoreboard. |

## Config

Default mode resolves exactly like upstream: `PONYTAIL_DEFAULT_MODE` env → 
`~/.config/ponytail/config.json` (`{ "defaultMode": "lite" }`) → `full`.
Set `off` to stop auto-activation; a session then stays quiet until you run
`/ponytail`.

## Layout

- `index.js` — the Cordis plugin: `apply(ctx)` registers the skill provider,
  the always-on system-prompt section, the `/ponytail` command, the pre-step
  deactivation hook, and the `/dsh-ponytail/status` + `/dsh-ponytail/sync`
  routes.
- `client.js` — the web half: the **Ponytail** settings page (sync button +
  version/status readout).
- `skills/` — the six ponytail skills, copied from upstream v5.3.3.
- `cordis.patch.yml` — the DSH bundle layer that inserts the plugin row.
- `scripts/sync-upstream.mjs` — re-packages the plugin from the latest upstream
  release (see *Syncing upstream* below).
- `test.mjs` — self-test / smoke test (`npm test`), also run by the sync script.
- `LICENSE` — MIT, copied from upstream.

## Install

As a local bundle (bundle package = a package whose `package.json` declares
`dsh.bundle.patch`):

```sh
dsh plugin --profile <name> add /path/to/dsh-ponytail
```

The profile must load bundles providing the `skills`, `systemPrompt`,
`commands` and `webServer` services (`@deepseek-ai/dsh-base` does). Verify the layer is present
with `dsh --profile <name> --dump-config` (look for the `dsh-ponytail` insert),
then restart the app so the new plugin mounts.

Alternatively, add the row by hand to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: ponytail
      name: dsh-ponytail
```

### Local checkout vs git/npm install

- **Local checkout (`file:`) — recommended when you want the settings-page
  button to sync upstream skills.** Clone the repo and install from the path:

  ```sh
  git clone https://github.com/<you>/dsh-ponytail ~/dsh-ponytail
  dsh plugin --profile <name> add file:~/dsh-ponytail
  ```

  The **同步上游并重装 / Sync upstream & reinstall** button then runs
  `scripts/sync-upstream.mjs` in that checkout (pulling the
  `@dietrichgebert/ponytail` skills) and mirrors the refreshed files into the
  installed copy. Keep the directory where it is — the spec points at it.
- **git/npm install (`github:you/dsh-ponytail`) — for cross-machine
  distribution.** There is no local checkout; the button **reinstalls the same
  spec** to pull the latest commit of *your* repo (it does not fetch upstream
  itself). Update your repo first (`node scripts/sync-upstream.mjs && git
  push`), then click the button.

## Syncing upstream

When the upstream ponytail repo publishes a new version, run one script — it
re-downloads upstream, refreshes every skill body, records the version, and
re-runs the self-test (rolling back on failure):

```sh
node scripts/sync-upstream.mjs            # track the latest release
# or, equivalently:
npm run sync

node scripts/sync-upstream.mjs --pack     # also build dist/dsh-ponytail-<ver>.tgz
```

The script fetches the upstream npm package (`@dietrichgebert/ponytail`), copies
each `skills/<name>/SKILL.md`, writes `package.json`.`upstream = { name, version }`
and mirrors the version as the plugin version. Everything DSH-specific
(`index.js`, `cordis.patch.yml`, README, LICENSE) is left alone.

| Flag | Effect |
|---|---|
| `--version <v>` | Pin a specific upstream release instead of `latest`. |
| `--keep-version` | Don't change this package's `version`. |
| `--no-test` | Skip the self-test (not recommended). |
| `--dry-run` | Fetch and report changes without writing anything. |
| `--pack` | Also `npm pack` a distributable tarball into `dist/`. |

### From the DSH settings page

After installing, open **Settings → 集成 → Ponytail**. The page shows the
upstream and installed versions and has one **同步上游并重装 / Sync upstream &
reinstall** button. It runs the same `scripts/sync-upstream.mjs` in the plugin
source, then mirrors the refreshed `skills/` and runtime files into the
installed copy under the profile's `node_modules` (a direct copy, because
`pnpm install` reports "Already up to date" and never re-copies an unchanged
`file:` dependency). **Restart DSH afterwards** to load the new skills and
ruleset — the plugin modules already loaded in the running host are not
re-imported.

If the plugin was installed from a **git or npm spec** (e.g.
`github:you/dsh-ponytail`) there is no local source checkout; the button then
**reinstalls the same spec** (`pnpm remove` + `pnpm add <spec>`) to pull the
latest commit. The profile's `package.json`/lockfile and the installed copy are
backed up first and restored if the reinstall fails, so a broken network never
leaves the plugin uninstalled.

The button and its routes are loopback- and same-origin-gated, because a
route that runs commands and rewrites the profile is otherwise a remote-code
execution surface.

A background check runs as soon as the web client loads (no need to open the
page) and every 10 minutes while it is on. When it finds a newer upstream
release, a red dot appears on the Ponytail item in the settings nav and on the
action beside **Settings** in the sidebar foot; clicking the sidebar action
syncs immediately. Turn the check off with the "自动检测上游新版本" checkbox on
the page.

## Upstream

- Source: <https://github.com/DietrichGebert/ponytail> (MIT, Dietrich Gebert)
- Update with `scripts/sync-upstream.mjs` (see above).
