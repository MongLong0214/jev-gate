# Jev Gate for Codex

Automatic Gate, Lean, Router and Compact run in the **native Codex terminal**, using the official App Server and the same Jev policy core as Claude Code. The installed plugin supplies hooks, Evidence MCP, Output folding and the launcher. Your Codex login, terminal UI, permissions and execution engine remain native.

Requires **Node 22.15+**. The native runtime was tested with **Codex CLI 0.158.0 and 0.159.2**. Newer Codex versions must pass the runtime suite before their behavior is considered verified. The launcher connects the terminal UI; it does not attach policies to an already open desktop or extension session.

## Install

From this repository checkout:

```sh
npm ci
npm run build
codex plugin marketplace add "$PWD"
codex plugin add jev-gate@jev-gate-codex
```

For the release archive, extract `jev-gate-codex-<version>.zip`, add that extracted directory as the marketplace, and install the same plugin name. The archive includes its dependencies; it needs no installed `node_modules`. A raw Git checkout must be built first.

Open native `codex`, use `/hooks` to review and trust the Jev Gate hooks, then exit that session. Enable only one Jev Gate installation in `/plugins`; the launcher refuses duplicate active hooks to prevent repeated policy calls. Installation alone does not trust hooks. For vetted automation, Codex's explicit `--dangerously-bypass-hook-trust` flag grants trust only for enabled Jev hooks in this process; no persisted trust configuration is edited. The plugin's MCP server is named `jev_gate_evidence` to coexist with an existing server named `evidence`.

## Start all automatic policies

**In the Git project you want to work on**, replace `<plugin>` with the absolute installed plugin directory (or `/absolute/jev-gate/plugins/codex` in a built checkout):

```sh
export JEV_CODEX_WORKSPACE="$PWD"
# Supply TYPESAFE_API_KEY through your environment for Jev judgments.
node <plugin>/dist/cli.mjs codex
```

Use native model and permission options normally:

```sh
node <plugin>/dist/cli.mjs codex --model gpt-6.1-sol --sandbox workspace-write
```

Choose a model your Codex account actually supports. The default tier mappings use the session's selected model; different worker models are opt-in. Jev failures, a missing key, unsupported input, unknown context depth and invalid judgments preserve the original policy path. Starting a fresh session through this command registers the owned `jev_agent` tool. Existing sessions created without that tool should be continued in ordinary Codex or started fresh through the launcher.

An ordinary `codex` session with the plugin still provides Evidence, Output and lifecycle observation. **Automatic policies need the launcher connection.** A plugin command hook alone cannot apply per-turn model settings or consume worker input patches without permission changes.

The session connection is an authenticated loopback WebSocket to `codex app-server --stdio`; the real terminal uses Codex's `--remote` option. Hooks call the local adapter, and the adapter applies the shared Gate/Lean state machine. Native approval requests are passed to the terminal unchanged. A temporary Responses provider forwards native authentication to OpenAI and observes actual model settings. No login files are read, credentials logged, daemon installed or user configuration edited.

## Feature behavior

| Feature | Automatic connected session |
| --- | --- |
| Gate A | Reads observed native context usage; Jev judges context and cost support; code chooses direct, single-worker or planned delegation and enforces the depth floor |
| Gate B | Applies shared tier policy to the exact owned dispatch; checks account model availability |
| Planning | Only on the planned path: runs the existing read-only planner instructions in a native Codex thread and validates the returned task graph |
| Workers / acceptance | Runs real foreground Codex workers; compares reports with observed command exits and edits. The current shared core does not call Gate C; acceptance is owned by code on both hosts. |
| Root guard | Enforces the shared root allowlist while a job is admitted; never returns an allow decision |
| Lean | Uses attributed App Server items; retains user constraints, selects optional groups with Jev, and applies a packet to one executor; no Gate or plan runs on this path |
| Router | Uses shared ordered probabilities and the live account catalog; applies official `turn/start` settings and confirms the actual Responses request |
| Compact | Produces the shared extractive digest on automatic local compaction; Codex installs it through its own state machine; unsupported extraction falls back to native compaction |
| Output | Folds only identical consecutive lines in complete passing Vitest output; preserves failures, truncation and unknown formats |
| Evidence | Same local search, Jev judgments, pagination, cache and exact source read-back as Claude Code |

Native permissions remain authoritative for root and workers. Planners use a read-only sandbox; custom named permission profiles are preserved and planner shell commands are denied under them. Workers cannot create another coordinator. Worktree isolation creates a separate branch and leaves it for inspection and integration; it does not silently merge changes.

The default concurrency is 1. Newly admitted auto/atomic work uses **Gate A → Gate B → one worker → code acceptance**, without a planner or shape-only questions. The one worker can investigate, implement and run checks. Planned delegation remains available through explicit configuration or the auto shape policy above concurrency 1. Once terminal work is accepted and no agents are active, the root continues remaining integration, review and reporting. Acceptance does not certify complete coverage of every user requirement.

Missing source, unknown checks and a worker's self-reported pass never become observed success. Check verification sees native command exits and file-change events; shell-based edits and external editor writes are not established by those events. Encrypted reasoning, media, pending calls or an oversized mandatory context cannot be guessed; these cases use native compaction/handoff behavior. Digest bytes are not measured token or billing savings. Manual `/compact` stays native unless explicitly enabled below.

## Policy settings

Use `JEV_CODEX_CONFIG=/absolute/codex.json`, otherwise `~/.config/jev-gate/codex.json`. No file is required. Configuration changes take effect in a new connected session.

```json
{
  "gate": {"mode":"auto"},
  "router": {"enabled":true,"model":false,"effort":true,"timeoutMs":800},
  "compact": {"enabled":true,"manual":false,"budgetChars":40000}
}
```

`gate` accepts the shared V5 options, including `mode: "lean"`, depth floors, budgets, checks and `workerIsolation`. Its four `models` entries must be native model IDs available to your Codex account. `router.model` is enabled only with explicit accessible tier mappings; effort routing is on by default. Router has the same directional probability thresholds (upgrade 0.8, downgrade 0.6). `JEV_GATE_MODE` overrides the Gate mode only; `gate.mode: "off"` does not disable Router or Compact.

### Current Codex models and efforts

The router reads the complete native `model/list` catalog. It has no model-name whitelist and does not pin GPT-5.5. Default worker mappings follow the selected native session model; use Codex `/model` or `--model` to choose it. Model changes require your explicit tier mapping and `router.model: true`.

Observed in Codex CLI 0.159.2 on 2026-09-30:

| Native model | Supported routing efforts |
| --- | --- |
| `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-luna` | low, medium, high, xhigh, max |
| `gpt-5.6-terra`, `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |

Terra, older models and account-specific models remain usable when the live catalog supports them. Availability and defaults depend on your account and host; the table is an observation, not a permanent allowlist. Effort questions offer only the current model's supported levels. Unknown efforts preserve native settings. Unsupported model/effort combinations are refused; the highest effort is not selected simply because it exists.

`ultra` is a native Codex selection. Codex resolves it to the model's ordinary inference effort (observed as `xhigh` or `max`, depending on the model's live catalog), rather than sending a literal `ultra` API value. Jev passes the official selection unchanged. The dashboard records the selected effort, the official host setting and the observed inference request separately; no `ultra` request is fabricated.

For example, this **opt-in** mapping includes Terra:

```json
{
  "gate": {"models": {"fast":"gpt-6-luna","standard":"gpt-5.6-terra","deep":"gpt-6.1-sol","frontier":"gpt-6-astra"}},
  "router": {"model":true}
}
```

Native ChatGPT requests follow the official App Server's workspace backend and residency routing. Credentials stay in the native host and authenticated forwarding path; the launcher does not read credential files.

| Environment | Effect |
| --- | --- |
| `JEV_CODEX_WORKSPACE` | Absolute Evidence workspace; set again when switching projects |
| `JEV_EVIDENCE_CONFIG` | Authoritative Evidence project/allowed roots/remote settings |
| `TYPESAFE_API_KEY` | Jev judgments; absent means native Gate/Lean/Router and local Evidence |
| `JEV_CODEX_CONFIG` | Absolute Codex policy JSON path |
| `JEV_CODEX_ENABLED=0` | Disable hooks and connected automatic policies; the separate Evidence MCP remains available |
| `JEV_CODEX_OUTPUT=off` | Preserve original tool output; lifecycle recording continues |
| `JEV_CODEX_TRACE_DIR` | Absolute recording directory; overrides `JEV_GATE_TRACE_DIR` |
| `JEV_DASHBOARD_NO_OPEN=1` | Print dashboard URL without opening a browser |
| `JEV_CODEX_UPSTREAM` | Owner-selected OpenAI-compatible Responses base URL; HTTPS or loopback HTTP only |

The launcher supports `-c`, feature switches, model, sandbox, approval policy, search and terminal display options. Provider/profile/additional-directory/worktree CLI switches that cannot be faithfully forwarded are rejected; configure native permissions and roots in Codex settings first. Custom model providers require an explicit compatible `JEV_CODEX_UPSTREAM`; the default authenticated transport targets native OpenAI endpoints.

Evidence scope is fixed when its MCP starts. The plugin-relative MCP working directory is never substituted for the project. An explicit Evidence configuration can narrow the scope:

```json
{"projectRoot":"/absolute/project","allowedRoots":["src"],"remote":false}
```

Restart after changing scope. Desktop apps may not inherit shell environment variables.

## Live dashboard

```sh
node <plugin>/dist/cli.mjs doctor
node <plugin>/dist/cli.mjs dashboard --port 4731
```

The local browser opens at `http://127.0.0.1:4731`. Keep this terminal running and use a second terminal for the connected Codex session. All ten feature stages are visible in four pipeline lanes; single-worker and planned delegation are separate paths. Select a stage or execution to see typed Jev judgments, measured latency, policy selection, worker checks and observed application. Router selection and actual model request are separate records; Compact generation and installation are separate records. Live events stream without reloading. Korean/English and light/dark controls are at the top right.

Records default to `$XDG_STATE_HOME/jev-gate/codex/traces` or `~/.local/state/jev-gate/codex/traces`. Private atomic metadata records contain no raw prompts, source, tool output, credentials or transcript paths. Missing records mean unknown. No simulated activity or inferred token savings is shown. Old records are not automatically deleted.

If no policy runs, check the connected launch command, `/hooks` trust, enablement, key and context floor. The first shallow turn often stays direct. `doctor` checks local readiness and configured Evidence scope, not login, hook execution or product effect.

## Verification and implementation references

```sh
npm run typecheck
npm test
npm run build
claude plugin validate . --strict
npm run test:codex:runtime
```

Ordinary tests use fake HTTP/CLI and no credentials. The native runtime suite installs a uniquely named disposable plugin and drives **real Codex processes** with a scripted local Responses provider. It verifies guarded root calls, workers, failed-check rejection, an actual file edit invalidating an earlier check followed by a successful recheck, plan dependencies, Lean packet application, cancellation, denial budgets, read-only permissions, planned-worker worktrees, automatic/manual digest installation, native Output, Evidence, GPT-6/6.1 and Terra model/effort application, and dashboard records; the temporary installation is removed afterwards. This establishes those execution paths, not every future host version or measured product savings.

The design was checked against the [official App Server](https://developers.openai.com/codex/app-server), [native hooks](https://learn.chatgpt.com/docs/hooks), [CaMe's native terminal connection](https://github.com/IlBig/CaMe), [jev-router's native Responses integration](https://github.com/gargpratyush/jev-router), [jev-use](https://github.com/shitianfang/jev-use), and [fast-jev-compaction-codex](https://github.com/Li-ship-dot/fast-jev-compaction-codex). These are architectural references, not a copied alternate execution engine. The [0.158.0 loader](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/loader.rs) uses the compatibility manifest and `.mcp.json`; root portable manifests currently omit plugin hooks.
