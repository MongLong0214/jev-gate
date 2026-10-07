<div align="center">
<img src="./assets/readme/jev-gate-logo.svg" width="460" height="77" alt="Jev Gate">

# Jev Gate

[![CI](https://github.com/MongLong0214/jev-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/MongLong0214/jev-gate/actions/workflows/ci.yml)
[![Node 22+](https://img.shields.io/badge/node-22%2B-3FB950)](package.json)
</div>

Jev-assisted model routing, delegation, evidence search, and context compaction for **Claude Code and native Codex**. Jev judges the task; code applies the policy; your coding host executes it. One local dashboard shows both hosts, their decisions, and observed results.

**Install the plugin and enter your Jev API key.** No project config, shell exports, trace-directory setup, dashboard terminal, or `claude --debug` flag is required. Node.js 22+ and your host's native login are required.

## Install

### Claude Code

In Claude Code:

```text
/plugin marketplace add MongLong0214/jev-gate
/plugin install jev-gate@jev-gate
```

Enter your Jev API key in the local screen that opens automatically. The plugin prepares its runtime settings. Restart Claude Code once if the startup notice asks: some host settings are read before plugins load. Existing explicit owner overrides are preserved and reported.

### Codex

Download the **Codex ZIP** from the [latest release](https://github.com/MongLong0214/jev-gate/releases/latest), extract it, then install the extracted directory:

```sh
codex plugin marketplace add /absolute/path/to/extracted-plugin
codex plugin add jev-gate@jev-gate-codex
```

Enter your key in the automatic local screen and use ordinary Codex in your project. The plugin discovers the workspace and prepares a local connection. Start a fresh Codex host after installation or upgrade; a running host retains its previous provider. Review installed hooks in `/hooks` if Codex asks for native trust. Keep one Jev Gate installation enabled. Automatic connection was tested with Codex CLI 0.160.0 and Node 22.15+.

Both hosts share one private key and dashboard. Installing from source is for development; run `npm ci` and `npm run build` before registering the checkout. [Codex configuration and troubleshooting](plugins/codex/README.md).

## What runs automatically

| Feature | Behavior | Jev usage |
| --- | --- | --- |
| Gate | Chooses direct execution, one background worker, or a plan with worker tasks. Code checks contracts and passing checks. | Eligible admission and allocation judgments; optional plan interpretation |
| Router | Selects model and effort from supported candidates for the root or eligible agents. Explicit pins are respected. | A task assessment when settings can change; steps reuse the task decision |
| Compact | Builds an extractive digest plus recent context. Jev prioritizes older successful results needed for the current task within the existing size budget. | One bounded candidate batch by default; timeout/invalid output keeps local selection |
| Output | Folds repeated successful Vitest output in Claude, and supported repeated tool output in Codex. | Local deterministic processing |
| Evidence | Returns verified source windows, paths, lines, hashes, and pagination. | Semantic candidates; exact symbols and read-back stay local |
| Dashboard | Shows both hosts' recorded judgments, requests, and outcomes live. | Reads local metadata; makes no Jev requests |

Gate, Router, Compact, Output, remote Evidence, recording, and automatic dashboard opening default to **on**. Lean is a separate selectable mode; it does not run Gate A/B or the planner. Automatic Astra/Fable targets default to off; enable both hosts with `frontierEnabled: true` in `~/.config/jev-gate/config.json`; manually selecting a root model does not enable automatic restricted children. [Router options](mods/router/README.md).

Default Gate settings permit native tools (`guardAllowTools: ["*"]`), up to 16 isolated workers, 64 planned tasks, a depth floor of 0, and plan interpretation. Worktree snapshots include current working files. Native permissions remain authoritative. Missing keys, invalid judgments, timeouts, or unavailable host facts preserve the native call.

Enabled does not mean every prompt delegates, routes, or compacts. The first Claude prompt may lack context usage for Gate admission. Simple bounded work can use a fast worker; broad or unclear tasks may remain direct. Jev probabilities are policy inputs, not measured success rates. No general speed, cost, or token saving is guaranteed.

Set the shared frontier switch in the ordinary config (merge this field into an existing file):

```json
{ "version": 5, "frontierEnabled": false }
```

`true` makes Claude Fable and Codex Astra eligible for automatic routing at their supported efforts. Jev still selects the model/effort pair for the task; explicit host pins remain authoritative. An explicit `false` overrides legacy `routerAllowFable` / `allowAstra` options. If the field is absent, legacy opt-ins remain compatible. The switch is reread at policy boundaries; an already selected manual root model is preserved.

The dashboard shows each host's current operation in a short live lane. Gate's decision tree and Router, Compact, Output, and Evidence's independent channels show how work proceeds. Signals move continuously along a recorded path while its destination is active; a brief pulse marks a newly recorded transition. Historical and idle channels remain static. One response strip contains latest latency, median, p95, and measured call count. Stage details and the execution timeline hold the decision evidence. All layouts fit without horizontal scrolling. Pause, disconnected streams, and reduced-motion preferences stop movement; signal motion is an active-work indicator, not a count of Jev calls.

## Keep talking while workers run

Owned workers, planners, and Lean executors dispatch in the background by default. New messages steer the main conversation without replacing the original job or its contracts. A launch receipt is separate from completion and contract acceptance.

Claude sends native completion notifications. Codex's coordinator can query `jev_agent` with `action: "status"` or explicitly cancel with `action: "cancel"` and the returned `agent_id`. Interrupting the main turn does not cancel an already running background worker. If Claude is busy with a foreground tool, use its native **Send now** shortcut; ordinary Enter may queue a message. [Background and host details](docs/advanced-usage.md).

### Understand model routing

The model picker establishes the baseline. Router reassesses each new task; selecting Sonnet once does not lock future tasks to Sonnet. Routine child steps reuse their existing assessment. Gate B owns the final model allocation for Jev workers; eligible ordinary agents use Router.

Simple lookup and mechanical worker tasks prefer Haiku in Claude or account-listed Luna in Codex. Codex candidates come from the account's actual `model/list`, including Terra when available. Claude root switching to Haiku can remain `context_unverified` where the host cannot prove request compatibility; fresh Haiku workers use no effort field.

“Do not edit” constrains work. “Do not delegate” keeps it in the main session. Neither pins a model or effort. Explicit model/effort instructions and host pins remain authoritative. Router also considers observed cache usage; a proposal can be held to preserve a useful cache. [Model, cache, and pin behavior](mods/router/README.md).

## Read the live dashboard

The plugin opens **one shared local browser dashboard** automatically. Starting another Claude or Codex session reuses it instead of opening duplicate tabs. Select **Claude + Codex**, **Claude Code**, or **Codex** to inspect each host.

1. Start a task in your normal coding session.
2. Read the current activity strip and execution circuit at the top. Select a stage to see its decision and latest result.
3. Choose an execution to follow its route, timeline, model observations, checks, and failures.
4. Use host/time filters and search to narrow records. Korean/English and light/dark controls are available.

| Record | Meaning |
| --- | --- |
| Running | A recorded request or stage is still awaiting its result |
| Complete | The recorded stage completed; a policy decision alone is not whole-task completion |
| Error | A specific Jev, host, Evidence, request-setting, or observed-model error was recorded |
| Unobserved | A needed fact is missing; success or failure cannot be inferred |
| Interrupted | User interruption was observed |
| No execution record | No matching event is available for this feature and range |

**Router · Request preparation** means pre-request checks finished. It is neither a new Jev judgment nor a completed model response. The dashboard distinguishes **selected model/effort**, **host dispatch or API request**, and **observed response**. The model card follows the selected timeline stage and names its record/time. A selection or submitted request alone cannot prove which model answered. Missing response effort stays unknown. A native Codex Compact summary request is recorded separately from root Router requests; its different effort is not a root routing failure. Older records without request purpose remain unconfirmed.

Circuit lines show possible paths. Moving lights require new connected records in the same execution. Response charts use measured Jev latency, not animations as a speed claim. Pause freezes the view; workers keep running. Reconnecting means the browser's event stream will retry. The latest 200 executions are listed; filters recompute displayed measurements and exclude earlier steps outside the range.

Dashboard and recording controls are independent and default to on. Both hosts use the same preferences. Turning recording off leaves Jev features running. Turning automatic dashboard opening off stops the managed server; a manually started view remains available.

```sh
node "<Claude plugin path>/dist/cli.js" dashboard on|off|status
node "<Claude plugin path>/dist/cli.js" recording on|off|status
# Codex packages use dist/cli.mjs.
```

Preferences live under `~/.config/jev-gate` (`$XDG_CONFIG_HOME` supported). No preferences file is needed for normal use. [Dashboard diagnostics and recorded-data limits](docs/advanced-usage.md#doctor-and-explain).

## Settings and data

Configure Claude options under `/plugin` → jev-gate → configure. Plugin options belong in **user settings**; project `pluginConfigs` are ignored by the host. Optional Codex settings are documented in the [Codex README](plugins/codex/README.md). You do not need either settings file for ordinary use.

Compact's Jev selection defaults to on with a 1,000ms deadline. Claude options are `compactJevEnabled` and `compactJevTimeoutMs`; Codex uses `compact.jevEnabled` and `compact.jevTimeoutMs`. Disable Jev selection to keep local Compact, or disable Compact entirely. [Compact options and fallback rules](mods/compact/README.md).

The key is stored in `~/.config/jev-gate/auth/credentials.json` (0700 directory/0600 file), shared by both hosts. Explicit environment/plugin keys take precedence. Saving validates format, not account validity or quota. TypeSafe billing is separate from Claude/Codex billing.

When enabled and eligible, these inputs can leave the machine:

- **Gate/Lean:** the request, composed task contracts, predecessor summaries, or selected prior-context groups. A needs-context retry can include recent user turns.
- **Router:** the task text and routing/cache facts used for its judgment.
- **Compact:** the current task and a bounded set of older successful-result excerpts. Sensitive candidates are filtered before sending. Mandatory preservation and final size limits remain local.
- **Evidence:** semantic goals, constraints, and candidate source windows. Exact-symbol queries and verified read-back do not call Jev.

The plugin does not upload the whole repository. Filters are not a DLP or retention guarantee. To disable remote Evidence, set `remote: false` in its optional config. That does not disable Gate, Router, Lean, or Compact's Jev selection. Output and the dashboard are local. [Evidence configuration](plugins/evidence/README.md#configure).

Recording stores private metadata under `~/.local/state/jev-gate/{claude,codex}/traces` (`$XDG_STATE_HOME` supported). Existing trace/debug paths remain supported. Prompt text, source bodies, tool output, and keys do not appear in the dashboard.

## Update and troubleshoot

For Claude:

```sh
claude plugin marketplace update jev-gate
claude plugin update jev-gate@jev-gate
```

Restart the host after upgrading to load new hooks/provider code. Old separate Jev plugins are automatically disabled where user settings permit; customized or managed overrides are preserved. Disabling one feature does not disable the others. Uninstalling does not delete credentials, traces, or transcripts.

| Symptom | Next step |
| --- | --- |
| No Jev calls | Check key, feature mode, pins, and eligibility in the stage detail and doctor |
| Compact/Router/Output absent | Restart after automatic setup; check preserved overrides with doctor |
| Dashboard absent | Check `dashboard status`, recording, and the local service with doctor |
| Model/effort warning | Inspect selected, submitted, and observed values; distinguish request mismatch from missing response facts |
| Evidence `partial` / empty | Check coverage and reason codes; an incomplete empty page is not proof of absence |
| Evidence `stale` | Search again; continue only with returned `next.offset` and `next.expectedSnapshot` |
| Settings seem ignored | Use user-level plugin options and start a fresh host |

Run `node "<plugin path>/dist/cli.js" doctor` (Codex: `cli.mjs`). A passing doctor checks local readiness; it does not prove API availability, model access, source accuracy, or performance. [Advanced usage](docs/advanced-usage.md).

## Development

[AGENTS.md](AGENTS.md) defines contributor rules; current issue bodies own specifications.

```sh
npm ci
npm run typecheck
npm test
npm run build
claude plugin validate . --strict
```

Unit tests use fake HTTP/CLI and require no keys or login. Native-host and browser E2E are opt-in. A performance claim needs a paired comparison with actual downstream outcomes; digest size or a successful Jev call alone is insufficient. [A/B benchmark](docs/bench-ab.md) · [Changelog](CHANGELOG.md) · [Open issues](https://github.com/MongLong0214/jev-gate/issues).
