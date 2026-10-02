<div align="center">

<img src="./assets/readme/jev-gate-logo.svg" width="460" alt="jev-gate">

# jev-gate

[![CI](https://github.com/MongLong0214/jev-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/MongLong0214/jev-gate/actions/workflows/ci.yml)
[![Node 22+](https://img.shields.io/badge/node-22%2B-3FB950)](package.json)

</div>

Jev-assisted task routing, evidence search, context compaction, and readable tool output for Claude Code and native Codex. Jev returns typed judgments; code applies the policy; the coding host executes the work. The local dashboard shows recorded activity as it happens.

The gate can change delegation and what the root session is allowed to run while a job is admitted. Main and subagent model routing are enabled by default, within host permissions and supported model controls. Results vary by task. No general saving is guaranteed.

The marketplace installs [the latest release](https://github.com/MongLong0214/jev-gate/releases/latest). Node.js 22 or later is required (`package.json`, `engines`).

## Codex native plugin

The [native Codex plugin](plugins/codex/README.md) connects **Gate A/B, planning, contract acceptance, root guard, Lean, Router and Compact** to ordinary native Codex through its local connection, alongside Evidence, Output and recording. Owned workers use the official Codex App Server; native login and permissions remain authoritative. Automatic connection was tested with Codex CLI 0.159.3 and Node 22.15+.

For an installation without a build step, download **`jev-gate-codex-0.8.2.zip`** from the [v0.8.2 release](https://github.com/MongLong0214/jev-gate/releases/tag/v0.8.2), extract it, and register the extracted directory:

```sh
codex plugin marketplace add /absolute/path/to/extracted-plugin
codex plugin add jev-gate@jev-gate-codex
```

Or build and install from a repository checkout:

```sh
npm ci
npm run build
codex plugin marketplace add "$PWD"
codex plugin add jev-gate@jev-gate-codex
```

Open ordinary **Codex** in your project. The installed plugin discovers the calling thread’s workspace and connects automatic policies locally. No workspace export, separate Jev terminal or project configuration file is required.

When the installed plugin starts, it opens a local **Jev API key** screen if no key is available. Enter the key once; Claude Code and Codex share the same private local credential. No shell export or policy file is required. Existing `TYPESAFE_API_KEY` and the Claude plugin's key option remain supported.

Codex owns login and hook trust: review/trust installed hooks in `/hooks` when the host requests it. Keep exactly one Jev Gate installation enabled in `/plugins`. Installation never forges a trust approval. A host already open during installation keeps its original model provider; start a fresh native host after the automatic connection is ready. Requires Node 22.15+; automatic connection was tested on Codex CLI 0.159.3. Build before installing a source checkout.

The dashboard opens automatically when the installed plugin starts. Claude Code and Codex share one local browser dashboard, with host filters and private recording enabled by default. No dashboard terminal, port selection, trace directory or `--debug` flag is needed.

For diagnostics, run `node /absolute/jev-gate/plugins/codex/dist/cli.mjs doctor`. Manual `dashboard --port 4733` remains available for development or a second view.

The Codex dashboard shows all ten feature stages and separates Jev selection from actual host application. With up to 16 isolated workers enabled by default, Jev chooses a single worker or a planner and dependency graph for independent outcomes. Ordinary native sessions use the automatic local connection for policies. The dashboard distinguishes a recorded policy decision from its observed application; an open session using its previous provider does not become connected retroactively.

[Native feature support, configuration, environment inheritance and troubleshooting →](plugins/codex/README.md)

## Install · Claude Code

In a Claude Code session:

```text
/plugin marketplace add MongLong0214/jev-gate
/plugin install jev-gate@jev-gate
```

Then enter your **Jev API key** in the local screen that opens automatically. That is the configuration: install the plugin and enter one key. A checkout, `npm`, environment-variable editing and a Gate config file are not required. You can also enter the same key through the plugin's sensitive `typesafeApiKey` option.

A TypeSafe key is not a Claude login. TypeSafe charges and limits are separate from a Claude subscription. With a key, Gate, the Router, and an Evidence semantic search can send a request or some source text to TypeSafe. They do not upload the repository as a whole. Compact and Output do not call Jev. Exact-symbol lookups and Evidence read-backs are not sent.

The plugin prepares missing Function Hooks and background-worker launch settings, trace/debug directories, and disables enabled obsolete `jev-gate-compact/-router/-output/-evidence` entries in user settings. It preserves unrelated settings, native permissions and explicit owner overrides. Responsive background workers and parallel snapshot worktrees are prepared automatically.

Claude Code reads some execution settings before loading plugins. On a fresh installation, the startup notice asks for **one host restart** after automatic preparation; no settings editing is needed. Already-open Codex hosts likewise need a fresh host to load a new provider, and Codex may require native hook trust approval. These are host lifecycle/security requirements, not extra Jev configuration. An explicit conflicting owner setting is reported and preserved.

### Ask questions while workers run

Owned planners, workers and Lean executors run in the background by default. The main conversation returns after dispatch, so you can ask another question while work continues. A new message keeps the original job and contracts; it does not cancel or replace them. Completion is checked against that original contract, even if several conversation turns arrived meanwhile. A start notification is not a completed or accepted result.

Claude Code delivers native completion notifications. In Codex, `jev_agent` supports `action: "status"` with the returned `agent_id` for an immediate result lookup, and `action: "cancel"` for explicit cancellation. These are coordinator tools; normal users continue using the same chat. Cancellation releases ownership only after an observed terminal event. An interrupted main turn does not cancel an already running background worker.

On upgrade, the complete old Jev-generated foreground profile is migrated automatically. Restart Claude Code once when the notice asks, because an already running host retains its launch environment. Customized owner overrides remain unchanged. If Claude is briefly busy with a main tool call, use its native **Send now** shortcut (Ctrl+Enter, or Ctrl+X then Ctrl+S); ordinary Enter can queue that message. See [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode).

The key is stored under `$XDG_CONFIG_HOME/jev-gate/auth/credentials.json`, or `~/.config/jev-gate/auth/credentials.json`, with a private directory and file (0700/0600). It is never put in a project, URL, command argument or diagnostic log. Both hosts read it; Evidence and Codex accept a newly saved key without an MCP restart. Existing explicit environment/plugin keys take precedence. Saving checks the key's format, not account validity, quota or API availability. Until a key exists, Gate/Lean/Router preserve native behavior and Evidence searches locally.

Every feature defaults to on, including main model routing, manual Compact and remote Evidence. The root tool allow-list is `["*"]`: Jev imposes no extra restriction on native tools, while the host still decides execution permissions. That does not mean every prompt is compacted, folded, routed, or delegated. The defaults enable up to 16 isolated workers, plans of up to 64 tasks, a depth floor of 0 and plan interpretation. Workers receive the current working files through private snapshots. Jev facts are batched into one request per eligible gate event. Router bounds all preparation to 800ms by default and skips requests that cannot change the final settings. The dashboard shows recorded Jev response times; these rules do not guarantee end-to-end speed or token savings.

Gate stays native for a direct admission, a missing key, or no `prompt_id`; none of those is a failure of the install. The default depth floor of 0 permits assessment even in a fresh session. `gateMode` `off` does not turn the other parts off. There is no master switch and no `evidenceEnabled` option.

Gate workers, planners, and the lean executor inherit the tools and connected MCPs that Claude Code provides to their session. A worker can inspect a linked Figma file or use an available browser or other MCP directly when its task needs one. Pass the target URL or ID and any restrictions in the brief. Host permissions still apply; `guardAllowMcp` controls only the admitted root session's guard, not a worker's tools.

The API key screen belongs to the existing MCP process and stops with it. In a headless environment its loopback URL is printed in MCP diagnostics. `JEV_GATE_NO_BROWSER=1` suppresses browser opening, and `JEV_GATE_ONBOARDING=0` disables automatic key entry for unattended runs. Neither is required for ordinary use.

## See it work live · Claude Code and Codex

The installed plugin opens one shared local dashboard automatically. Its execution circuit shows Gate's direct, single-worker and planned branches, independent Lean handoff, Router / Compact / Output policies, and Evidence search. Select a stage or execution to inspect Jev judgments, measured response time, code policy, model application and host outcomes. The host filter lets you view Claude Code, Codex or both. Korean/English and light/dark controls are in the top right.

Recording defaults to on and does **not** require `claude --debug`. Both hosts record private metadata under `~/.local/state/jev-gate/{claude,codex}/traces` (or `$XDG_STATE_HOME`). An existing explicit trace/debug path remains supported. The dashboard shows metadata only; it does not send requests to Jev or expose prompts, source bodies, tool output or API keys.

The settings panel has independent switches for **execution recording** and **automatic dashboard opening**. Both default to on and apply to both hosts. Turning recording off leaves Jev features running. Turning automatic opening off stops the automatically managed server; a manually started view stays available. The same settings can be changed with either host's CLI:

```sh
node "<installPath>/dist/cli.js" dashboard on|off|status
node "<installPath>/dist/cli.js" recording on|off|status
# Codex packages use dist/cli.mjs.
```

The dashboard preference is `~/.config/jev-gate/dashboard/config.json` (`$XDG_CONFIG_HOME` is supported): `{ "version": 1, "enabled": true }`. Recording has the same format at `~/.config/jev-gate/auth/recording.json`. Neither file is needed for ordinary use. Manual `dashboard --port 4733` is available for development.

| Dashboard state | What it means |
|---|---|
| **Observed** | The feature emitted a record. Select it to inspect the outcome. |
| **No execution record** | No event for this feature is available in the selected host/time range. |
| **Source unavailable** | The recording directory could not be read. Run `doctor` to check local readiness. |
| **Unconfirmed** | A response or actual model observation is missing; it is not counted as confirmed execution. |
| **Model mismatch** | Selected and observed models differ. Both values are shown. |

Circuit lines explain possible paths. A moving light requires a new connected event in the same recorded execution. Charts use measured Jev response times; quiet screens stay quiet. Missing usage remains unknown. Compact and Output run locally without Jev, and packet size is not measured token savings. See [recording details and limits](docs/advanced-usage.md#doctor-and-explain).

## The five parts

Options are the names in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json). Set them under `/plugin` → jev-gate → configure. A `--plugin-dir` load of this repository uses the key `jev-gate@inline` instead of `jev-gate@jev-gate`.

| Part | What it does | Default | Jev |
|---|---|---|---|
| Gate | Admits a request as direct (the session continues), single (one worker carries the request), or orchestrated (a planner, then workers). Root tools remain open with the default `["*"]`; an explicit narrower policy limits them. This is not the Router. | `gateMode` `auto` (`native` and `off` send no Gate request; `lean` is a separate mode) | Only in `auto` or `lean`, and only when the call is eligible |
| Compact | At an auto-compaction it can answer, replaces older context with an extractive digest plus a recent tail. If its own conditions fail, the engine compacts. | `compactEnabled` true, `compactMode` `active` | No. [Details](mods/compact/README.md) |
| Output | Folds runs of identical consecutive lines in one case: a passing `vitest run` log the host saved to a file. Not a general CLI or failure-log compressor. | `outputEnabled` true | No. [Details](mods/output/README.md) |
| Router | May change the root turn's model and effort, and a routed subagent's model and effort. Main model routing is enabled by default, including the frontier profile. Pins and an unverified host stay native. | `routerEnabled` true | When it has something to ask. [Details](mods/router/README.md) |
| Evidence | When called, returns source windows with path, lines, and a file hash, a page at a time, and can read a window back. It does not write files. | No switch. Without a config file, the session's Git worktree, remote on if a key is present | A semantic page only. Exact symbols and read-backs are not sent. [Details](plugins/evidence/README.md) |

## First use

`/jev-gate:evidence` is a skill you type. It is not the tool call. The tool is `jev_evidence` (host name `mcp__plugin_jev-gate_evidence__jev_evidence`). [`disable-model-invocation: true`](plugins/evidence/skills/evidence/SKILL.md) only stops Claude from invoking that skill on its own. It does not stop Claude from calling the tool, and it does not mean every prompt searches.

Typing a name does not by itself choose an exact lookup or guarantee that nothing is sent. The arguments do.

`parseRequest` is a function in this repository (`src/evidence/service.ts`). An exact lookup, which is not sent to Jev:

```text
/jev-gate:evidence where is parseRequest defined?
```

```json
{
  "goal": "where parseRequest is defined",
  "exactSymbols": ["parseRequest"]
}
```

`buildDigest` lives in `mods/compact/hooks`, not under `src`. A semantic question with short lexical hints and a narrow root:

```text
/jev-gate:evidence how is the compaction digest built?
```

```json
{
  "goal": "how the compaction digest is built and budgeted",
  "queryTerms": ["buildDigest", "budget"],
  "roots": ["mods/compact/hooks"]
}
```

When `queryTerms` is set, those terms are the only lexical hints. The goal is not trimmed into terms. On a semantic call with remote on, the goal and `constraints` are still what is sent for judgement. Without `queryTerms`, locate takes terms from the goal.

`status: "partial"` means something was not read, judged, or included; `coverage` and `reasonCodes` say what. A stopped page is the prefix collected in file and line order, not a ranking of the whole repository. No candidate, and an empty page, are not proof that a symbol is absent. When `next` is set, continue with the same arguments plus `offset` and `expectedSnapshot` from that `next`. A read-back of a file that changed returns `stale` and no text. Argument shapes, pages, and limits: [Evidence](plugins/evidence/README.md#use).

## Settings, data, and what leaves the machine

You do not need a Gate config file. The switches most people change are `gateMode`, `compactEnabled`, `outputEnabled`, and `routerEnabled`. Put plugin options in user settings, not in a project `.claude/settings.local.json` (that copy is ignored). Merge; do not replace the file.

```json
{
  "pluginConfigs": {
    "jev-gate@jev-gate": {
      "options": {
        "gateMode": "off",
        "routerEnabled": false
      }
    }
  }
}
```

`pluginConfigs` are read from user settings, from an explicit `--settings` file, and from managed settings. The same key in project settings or in project `.claude/settings.local.json` is ignored. `env` in project settings is a different contract: a project `.claude/settings.json` or `.claude/settings.local.json` can set `TYPESAFE_API_KEY` and `JEV_EVIDENCE_CONFIG`. That does not make `pluginConfigs` in the same file apply.

On Claude Code 2.1.284 only, an unset `gateMode` is not exported, so it does not override a config file. A valid explicit `JEV_GATE_MODE` wins, then an explicit `gateMode`, then a valid config file, then the call-path default (`auto` only for a legacy plugin hook with no file; `off` for `--lean`, doctor, and a bare `node`). That check was this host and this install. It was not repeated on other versions. The resolver is [Advanced usage](docs/advanced-usage.md#mode-precedence).

To keep Evidence's source on the machine, point `JEV_EVIDENCE_CONFIG` at an absolute path to a JSON file. `remote: false` stops Evidence's sends to TypeSafe only. The server still reads local files. It is not an offline mode for Claude, and it does not stop Gate or the Router. The paths below are an example for a project whose source is in `src` and `tests`. They are not this repository, and they are not required. Do not put the API key in this file. [Configure](plugins/evidence/README.md#configure).

```json
{
  "projectRoot": "/absolute/path/to/worktree",
  "allowedRoots": ["src", "tests"],
  "excludeGlobs": ["**/private/**"],
  "remote": false
}
```

To stop Gate and the Router from calling Jev as well, set `gateMode` to `off` and `routerEnabled` to false, then restart the session. Compact and Output still do not call Jev and can stay on. Disabling the `evidence` server in `/mcp` stops that server from reading files. Disabling the whole plugin is a different step, below.

Three different sends, when each part is on and has a key:

- Gate, in `auto`: the user request at admission, and the composed task contract with predecessor summaries at a planner or worker dispatch. `lean` sends something else; that is in the advanced page. `native` and `off` send no Gate request.
- Router: the text of the decision it is asking (a root turn, or a subagent prompt). Not the Gate contract.
- Evidence, semantic search with `remote` true: the goal, constraints, and a page of windows. Not an exact-symbol lookup, and not a read-back.

Installing the plugin does not upload the repository. A local process is not a promise that nothing is sent. A Native Read deny is not inherited by the Evidence reader; if the same restriction cannot be applied here, disable that server. Built-in exclusions are a filter, not a DLP, a no-retention promise, or proof that an organization approved a send.

A worker accept is an observed passing run of the declared check after the last observed Edit, Write, MultiEdit, or NotebookEdit in that worker's transcript. It does not certify an edit made inside Bash, by another editor, or by another process, and it does not certify that the check was the right one. It does not certify the current file contents.

## Update, turn off, remove

These are different:

```text
claude plugin marketplace update jev-gate
claude plugin update jev-gate@jev-gate
```

The first refreshes the marketplace catalog. The second installs the newer archive for this plugin. Auto-update for the marketplace can be turned on under Marketplaces in `/plugin`. A running session keeps the hooks and the Evidence process it started with. Quit Claude Code and start it again. `/reload-plugins` does not guarantee that a live Evidence server re-reads `JEV_EVIDENCE_CONFIG` or loads a new archive.

`gateMode` `off`, or one of `compactEnabled` / `outputEnabled` / `routerEnabled` set to false, turns that part off. It does not turn the others off, and it is not the same as disabling the plugin. `claude plugin disable jev-gate@jev-gate` disables the plugin (doctor prints the same command with `<marketplace>`). `claude plugin uninstall jev-gate@jev-gate` removes it. Neither command deletes job files, traces, settings, credentials, or transcripts.

From v0.5.x, the separate plugins `jev-gate-compact`, `jev-gate-router`, `jev-gate-output`, and `jev-gate-evidence` are gone from the marketplace and will not update. Initialization disables their enabled user-settings entries automatically; it does not delete their files or data. Project/managed installations and explicit overrides remain under host control. Option names changed. The list is in the [changelog](CHANGELOG.md).

## Troubleshooting

| What you see | What it is | What to do |
|---|---|---|
| Compact, Output, or the Router never registers | The host started before automatic initialization, or an explicit owner setting disables Function Hooks | Restart once after the startup notice; run doctor for preserved conflicts |
| Gate and the Router stay native; Evidence says `missing_key` | No usable Jev key. Not a failed Claude login | Enter the key in the automatically opened local screen; saving is not API validity verification |
| Gate stays native and sends nothing | Foreground conditions, depth floor, a direct admission, mode `native` or `off`, or no `prompt_id` | [Advanced usage](docs/advanced-usage.md). Not the missing-key row |
| `unavailable_config` or `unsupported_inventory` | The Evidence file is invalid, or the session is not in a Git worktree. An invalid file does not fall back to the whole worktree | Fix the file or open a worktree, then restart. Doctor below |
| `partial`, no candidate, or `stale` | An incomplete page, or the file changed. An empty page is not proof of absence | Read `coverage` and `reasonCodes`. Continue only with the same snapshot. After `stale`, search again |
| A switch seems ignored | `pluginConfigs` in project or local settings are ignored; an unset `gateMode` is not exported; Evidence keeps the config it started with | User settings or an explicit `--settings` file, then a new session |
| Hooks run twice | A v0.5.x plugin remains active from a project/managed source or an already-loaded host | Restart after initialization; use `/plugin` for host-controlled installations. [Changelog](CHANGELOG.md) |

Doctor is not one program.

- Checkout, after `npm run build`: `node dist/cli.js doctor` from the repository root.
- Installed bundle: `node <plugin-dir>/dist/cli.js doctor`, where `<plugin-dir>` is the directory that contains that `dist/cli.js`.
- Evidence, same bundle: `node <plugin-dir>/plugins/evidence/dist/server.mjs --doctor`. A standalone Evidence archive uses `node <dir>/dist/server.mjs --doctor`.
- Dashboard: follow [See it work live](#see-it-work-live--claude-code) to open the local page and interpret its records.

A passing doctor means the files and the config it could read look usable. It is not model access, not source accuracy, not a valid key, and not a performance guarantee. Evidence doctor reads the config only: no source scan and no request.

## Development

Contributor rules are in [AGENTS.md](AGENTS.md). From a checkout:

```sh
npm ci
npm run typecheck
npm test
npm run build
claude plugin validate . --strict
```

A saving claim needs the paired A/B bench (`node dist/bench/ab.js`, see `docs/bench-ab.md`), not a within-session estimate. `npm test` uses fake HTTP and a fake CLI. It does not need a key or a login. The bench is not part of installing or of changing the plugin. Do not send secrets or raw transcripts.

`claude --plugin-dir .` loads this tree as the plugin. One part can be loaded from `mods/compact`, `mods/output`, `mods/router`, or `plugins/evidence`; option names differ, and those READMEs say how. Gate and lean settings, background execution and worktree conditions, and `node dist/cli.js explain` are in [Advanced usage](docs/advanced-usage.md).

## Older work

Open work is the [issue list](https://github.com/MongLong0214/jev-gate/issues). Closed specifications are history, not a current plan: the [V5 PRD](https://github.com/MongLong0214/jev-gate/issues/21) and [ADR](https://github.com/MongLong0214/jev-gate/issues/22), legacy routing [#23](https://github.com/MongLong0214/jev-gate/issues/23)–[#31](https://github.com/MongLong0214/jev-gate/issues/31), lean [#33](https://github.com/MongLong0214/jev-gate/issues/33)–[#36](https://github.com/MongLong0214/jev-gate/issues/36) and its [measurement issue](https://github.com/MongLong0214/jev-gate/issues/29), and V3/V4 issues [#1](https://github.com/MongLong0214/jev-gate/issues/1)–[#18](https://github.com/MongLong0214/jev-gate/issues/18).

Recorded runs, including ones that cost more or did not engage, are linked from [Advanced usage](docs/advanced-usage.md#recorded-runs). They are not retuned here.
