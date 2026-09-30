<div align="center">

<img src="./assets/readme/jev-gate-logo.svg" width="460" alt="jev-gate">

# jev-gate

[![CI](https://github.com/MongLong0214/jev-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/MongLong0214/jev-gate/actions/workflows/ci.yml)
[![Node 22+](https://img.shields.io/badge/node-22%2B-3FB950)](package.json)

</div>

Jev-assisted task routing, evidence search, context compaction, and readable tool output for Claude Code, with a separate native Codex adapter for Evidence, output folding, and execution observability. Jev returns typed judgments; code applies the policy; the coding host executes the work. The local dashboard shows recorded activity as it happens.

The gate can change delegation and what the root session is allowed to run while a job is admitted. The session's model stays whatever Claude Code already set. Results vary by task. No general saving is guaranteed.

The marketplace installs [the latest release](https://github.com/MongLong0214/jev-gate/releases/latest). Node.js 22 or later is required (`package.json`, `engines`).

## Codex native plugin

Codex has a separate [native plugin](plugins/codex/README.md): the same Evidence MCP, conservative Vitest output folding, and live tool/agent/compaction records. **Automatic Gate/Lean/Router, Jev contract enforcement, and compaction replacement are not supported by this adapter.** The dashboard displays those limits explicitly. This is not full Claude Code parity.

Build and install from the repository checkout:

```sh
npm ci
npm run build
codex plugin marketplace add "$PWD"
codex plugin add jev-gate@jev-gate-codex
```

Then, **in the Git project you want to inspect**:

```sh
export JEV_CODEX_WORKSPACE="$PWD"
codex
```

Review and trust the Jev Gate definitions in `/hooks`. Set the workspace again when switching projects; missing workspace configuration refuses Evidence searches. Requires Node 22+; tested on Codex CLI 0.158.0. Build before installing a source checkout.

Use the absolute path of this checkout (or the installed Codex plugin) for diagnostics and the dashboard:

```sh
node /absolute/jev-gate/plugins/codex/dist/cli.mjs doctor
node /absolute/jev-gate/plugins/codex/dist/cli.mjs dashboard
```

The dashboard opens on **http://127.0.0.1:4731**. Choose another port with `--port 4733` if it is in use. Hooks and MCP record to the same private Codex trace directory by default. Korean/English and light/dark controls are in the top right.

[Native feature support, configuration, environment inheritance and troubleshooting →](plugins/codex/README.md)

## Install · Claude Code

In a Claude Code session:

```text
/plugin marketplace add MongLong0214/jev-gate
/plugin install jev-gate@jev-gate
```

That is the install. A checkout, `npm`, and the old separate plugins are not required.

A TypeSafe key is not a Claude login. TypeSafe charges and limits are separate from a Claude subscription. With a key, Gate, the Router, and an Evidence semantic search can send a request or some source text to TypeSafe. They do not upload the repository as a whole. Compact and Output do not call Jev. Exact-symbol lookups and Evidence read-backs are not sent.

Merge the following into the `env` object of the settings Claude Code starts with. Do not replace the rest of the file. The usual file is user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`). The value is a placeholder, not a real key.

```json
{
  "env": {
    "TYPESAFE_API_KEY": "<your-typesafe-api-key>",
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

Three different gaps:

- No key: Gate and the Router leave the call native. Evidence still searches locally and reports `missing_key`. That is not the same as `remote: false`.
- No `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment Claude Code starts in: Compact, Output, and the Router are not loaded. Gate's command hooks and the Evidence server still run.
- Foreground conditions unmet (a session that cannot run a foreground worker, or a concrete subagent-model override): Gate `auto` and `lean` stay native and send no Gate request. See [Advanced usage](docs/advanced-usage.md).

Every part defaults to on. That does not mean every prompt is compacted, folded, routed, or delegated. Gate often stays native: a direct admission, a shallow session, a missing key, or no `prompt_id` are different cases, and none of them is a failure of the install. `gateMode` `off` does not turn the other parts off. There is no master switch and no `evidenceEnabled` option.

Gate workers, planners, and the lean executor inherit the tools and connected MCPs that Claude Code provides to their session. A worker can inspect a linked Figma file or use an available browser or other MCP directly when its task needs one. Pass the target URL or ID and any restrictions in the brief. Host permissions still apply; `guardAllowMcp` controls only the admitted root session's guard, not a worker's tools.

End the session and start Claude Code again after changing settings. There is no setup command.

## See it work live · Claude Code

The dashboard runs on your machine and opens in your browser. Its four lanes show the **Gate** (admission, plan, tier allocation, workers, and root guard), the separate **Lean** handoff, the independent **Router / Compact / Output** hooks, and **Evidence** search. Select any stage to read what it does, when it runs, whether it calls Jev, and the recorded outcome. The timeline separates the Jev request and response from the code decision and the host's execution. Korean/English and light/dark controls are in the top right.

1. **Record new activity.** Add these absolute directories to the same settings `env` as above, then restart Claude Code. The trace directory is used by Gate and Evidence; point the debug variable to the host debug directory used by Router, Compact, and Output. For a macOS default install, inspect `~/.claude/debug` first. Replace both example paths with paths on your machine.

   ```json
   {
     "env": {
       "JEV_GATE_TRACE_DIR": "/absolute/path/to/jev-traces",
       "CLAUDE_CODE_DEBUG_LOGS_DIR": "/absolute/path/to/claude-debug"
     }
   }
   ```

2. **Run a request in Claude Code.** A feature appears as *observed* when that feature emits a record. A configured source with no event says *awaiting record*. A missing or unreadable source says *source unavailable*. Previously unrecorded activity cannot be reconstructed.

3. **Open the dashboard.** From a built checkout, run `node dist/cli.js dashboard`. For a marketplace install, find the current installed path with `claude plugin list --json` (`installPath` for `jev-gate@jev-gate`) and run:

   ```sh
   node "<installPath>/dist/cli.js" dashboard
   ```

   On macOS the command opens `http://127.0.0.1:4731/` automatically; elsewhere, open the printed URL. Keep the terminal running and press Ctrl-C to stop. The page updates through a local event stream as records arrive. For a different port or record directories, use `dashboard --port 4732 --trace /path/to/jev-traces --debug /path/to/claude-debug` after `node dist/cli.js`. The page does not send requests to Jev or expose prompts, source bodies, or API keys.

| Dashboard label | What it means | What to check |
|---|---|---|
| **Observed** | This feature emitted at least one record. | Open its stage and inspect the latest decision and host result. |
| **Awaiting record** | The source is configured, but this feature has not emitted an event in the visible window. | Run a request that uses the feature; ordinary prompts do not exercise every feature. |
| **Source unavailable** | A trace or debug directory is missing or unreadable. | Check the two paths in settings, restart Claude Code, and reopen the dashboard. |
| **Unconfirmed** | An intent was recorded without a matching result. | Inspect the run timeline; do not treat an intent as a completed Jev call or worker action. |

The latency strip uses measured Jev response times, not a simulated speed value. Missing usage is unknown rather than zero. A projected token saving in Gate A is a routing estimate, not measured savings. Compact and Output run locally without Jev. The dashboard shows what the available records prove, so a quiet feature is not necessarily disabled. See [recording details and limits](docs/advanced-usage.md#doctor-and-explain).

## The five parts

Options are the names in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json). Set them under `/plugin` → jev-gate → configure. A `--plugin-dir` load of this repository uses the key `jev-gate@inline` instead of `jev-gate@jev-gate`.

| Part | What it does | Default | Jev |
|---|---|---|---|
| Gate | Admits a request as direct (the session continues), single (one worker carries the request), or orchestrated (a planner, then workers). An admitted job limits the root session's tools. This is not the Router. | `gateMode` `auto` (`native` and `off` send no Gate request; `lean` is a separate mode) | Only in `auto` or `lean`, and only when the call is eligible |
| Compact | At an auto-compaction it can answer, replaces older context with an extractive digest plus a recent tail. If its own conditions fail, the engine compacts. | `compactEnabled` true, `compactMode` `active` | No. [Details](mods/compact/README.md) |
| Output | Folds runs of identical consecutive lines in one case: a passing `vitest run` log the host saved to a file. Not a general CLI or failure-log compressor. | `outputEnabled` true | No. [Details](mods/output/README.md) |
| Router | May change the root turn's effort, and a routed subagent's model and effort. The root model stays unless you set `routeMainModel` (default false). Pins and an unverified host stay native. | `routerEnabled` true | When it has something to ask. [Details](mods/router/README.md) |
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

From v0.5.x, the separate plugins `jev-gate-compact`, `jev-gate-router`, `jev-gate-output`, and `jev-gate-evidence` are gone from the marketplace and will not update. Uninstall each (`claude plugin uninstall jev-gate-compact@jev-gate`, and the same for the other three) before updating `jev-gate`, or their hooks can run beside this one. Option names changed. The list is in the [changelog](CHANGELOG.md).

## Troubleshooting

| What you see | What it is | What to do |
|---|---|---|
| Compact, Output, or the Router never registers | The Function Hooks flag is missing from the environment Claude Code starts in | Merge the flag into `env` and restart. Gate and Evidence do not use that flag |
| Gate and the Router stay native; Evidence says `missing_key` | No `TYPESAFE_API_KEY` where the process can read it. Not a failed Claude login | Put the key in `env` and restart. Different from `remote: false` |
| Gate stays native and sends nothing | Foreground conditions, depth floor, a direct admission, mode `native` or `off`, or no `prompt_id` | [Advanced usage](docs/advanced-usage.md). Not the missing-key row |
| `unavailable_config` or `unsupported_inventory` | The Evidence file is invalid, or the session is not in a Git worktree. An invalid file does not fall back to the whole worktree | Fix the file or open a worktree, then restart. Doctor below |
| `partial`, no candidate, or `stale` | An incomplete page, or the file changed. An empty page is not proof of absence | Read `coverage` and `reasonCodes`. Continue only with the same snapshot. After `stale`, search again |
| A switch seems ignored | `pluginConfigs` in project or local settings are ignored; an unset `gateMode` is not exported; Evidence keeps the config it started with | User settings or an explicit `--settings` file, then a new session |
| Hooks run twice | A v0.5.x plugin is still installed | Uninstall it. [Changelog](CHANGELOG.md) |

Doctor is not one program.

- Checkout, after `npm run build`: `node dist/cli.js doctor` from the repository root.
- Installed bundle: `node <plugin-dir>/dist/cli.js doctor`, where `<plugin-dir>` is the directory that contains that `dist/cli.js`.
- Evidence, same bundle: `node <plugin-dir>/plugins/evidence/dist/server.mjs --doctor`. A standalone Evidence archive uses `node <dir>/dist/server.mjs --doctor`.
- Dashboard: follow [See it work live](#see-it-work-live) to open the local page and interpret its records.

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

`npm test` uses fake HTTP and a fake CLI. It does not need a key or a login. The bench is not part of installing or of changing the plugin. Do not send secrets or raw transcripts.

`claude --plugin-dir .` loads this tree as the plugin. One part can be loaded from `mods/compact`, `mods/output`, `mods/router`, or `plugins/evidence`; option names differ, and those READMEs say how. Gate and lean settings, foreground and worktree conditions, and `node dist/cli.js explain` are in [Advanced usage](docs/advanced-usage.md).

## Older work

Open work is the [issue list](https://github.com/MongLong0214/jev-gate/issues). Closed specifications are history, not a current plan: the [V5 PRD](https://github.com/MongLong0214/jev-gate/issues/21) and [ADR](https://github.com/MongLong0214/jev-gate/issues/22), legacy routing [#23](https://github.com/MongLong0214/jev-gate/issues/23)–[#31](https://github.com/MongLong0214/jev-gate/issues/31), lean [#33](https://github.com/MongLong0214/jev-gate/issues/33)–[#36](https://github.com/MongLong0214/jev-gate/issues/36) and its [measurement issue](https://github.com/MongLong0214/jev-gate/issues/29), and V3/V4 issues [#1](https://github.com/MongLong0214/jev-gate/issues/1)–[#18](https://github.com/MongLong0214/jev-gate/issues/18).

Recorded runs, including ones that cost more or did not engage, are linked from [Advanced usage](docs/advanced-usage.md#recorded-runs). They are not retuned here.
