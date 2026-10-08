# Jev Gate for Codex

Automatic Gate, Lean, Router and Compact connect to **ordinary native Codex** after the plugin starts. The plugin supplies hooks, Evidence MCP, Output folding and an authenticated local connection. Your login, permissions, terminal and official execution engine stay in Codex.

Requires **Node 22.15+**. Automatic connection was tested with **Codex CLI 0.160.0**. The optional managed terminal connection was also tested on 0.158.0. An already open session retains its original provider until a new session loads the automatic settings. Local Codex app/IDE sessions must use this Codex home and support the same native plugin, hook and provider APIs; a remote managed coding session is a separate host.

## Install

From this repository checkout:

```sh
npm ci
npm run build
codex plugin marketplace add "$PWD"
codex plugin add jev-gate@jev-gate-codex
```

For the release archive, extract `jev-gate-codex-<version>.zip`, add that extracted directory as the marketplace, and install the same plugin name. The archive includes its dependencies; it needs no installed `node_modules`. A raw Git checkout must be built first.

Open ordinary `codex` in the project. The installed MCP automatically opens a local **Jev API key** screen when no key is available. Enter the key once; Codex and Claude Code share `~/.config/jev-gate/auth/credentials.json` (or the XDG config location), protected by 0700/0600 permissions. No key is written into a project or Codex's config. Environment keys remain supported and authoritative. Evidence and the native connection read newly saved keys without restarting MCP.

Codex supplies the calling thread’s workspace; **no shell export, `JEV_CODEX_WORKSPACE`, Jev launcher or policy file is needed**. Enable one Jev Gate installation in `/plugins` and review/trust hooks when the native host requests approval. Installation does not forge hook trust or authenticate the key's API access. A host already running during installation needs a fresh host to load its new provider.

## Automatic connection

The trusted startup hook and installed MCP start one local helper per Codex home. The helper uses the official App Server to execute owned workers and observes ordinary native Responses requests for Router, context usage and compaction. It automatically writes only its model-provider entry, provider selection and compaction marker through Codex’s revision-checked configuration API. Unrelated settings and comments are preserved; API keys are never written there. A custom provider is preserved and automatic connection is declined rather than redirected.

Use Codex normally:

```sh
codex
# Native options still work:
codex --model gpt-6.1-sol --sandbox workspace-write
```

If a session was open before installation, start a new native session after connection readiness. The plugin cannot change a model provider already loaded by that host. `jev_agent` is installed as an MCP tool; only a current Gate/Lean dispatch can start an owned worker. Invalid judgments, missing keys, unsupported input and unknown depth preserve native execution.

Active plugin clients restart a failed helper. Disabling/removing the plugin restores only settings that still match Jev’s installed values; owner edits are retained. No OS login service is installed. To keep Evidence/Output without automatic provider integration, use `JEV_CODEX_AUTO_CONNECT=0` before plugin startup. Existing native login and configured `openai_base_url` / `OPENAI_BASE_URL` are preserved in the forwarding path. `JEV_CODEX_UPSTREAM` is an explicit compatible endpoint override.

The older `node <plugin>/dist/cli.mjs codex` managed terminal remains available for explicit connection and diagnostics. It is optional; ordinary use does not require it.

## Feature behavior

| Feature | Automatic connected session |
| --- | --- |
| Gate A | Reads observed native context usage; Jev judges context, cost support and bounded tool work; code chooses direct, one fast worker or planned delegation and enforces the depth floor |
| Gate B | Adds actual model/effort candidates to the existing Gate B batch; rechecks eligibility before owned dispatch |
| Planning | Only on the planned path: runs the existing read-only planner instructions in a native Codex thread and validates the returned task graph |
| Workers / acceptance | Runs real native Codex workers in the background by default; compares reports with observed command exits and edits. The current shared core does not call Gate C; acceptance is owned by code on both hosts. |
| Root guard | Enforces the shared root allowlist while a job is admitted; never returns an allow decision |
| Lean | Uses attributed App Server items; retains user constraints, selects optional groups with Jev, and applies a packet to one executor; no Gate or plan runs on this path |
| Router | Uses a nominal actual-ID model choice and candidate-local ordered effort scores; routes the original root request and separates selection, submission and actual response observation |
| Compact | Prioritizes current-task dependencies with a bounded Jev batch, then produces the shared extractive digest; Codex installs it through its own state machine; unsupported extraction falls back to native compaction |
| Output | Folds only identical consecutive lines in complete passing Vitest output; preserves failures, truncation and unknown formats |
| Evidence | Same local search, Jev judgments, pagination, cache and exact source read-back as Claude Code |

Native permissions remain authoritative for root and workers. Owned workers inherit the calling tool’s captured native filesystem grants and denies. Planners narrow those grants to reads and disable network. An unrepresentable permission snapshot refuses dispatch instead of guessing broader access. Workers cannot create another coordinator. Worktree isolation creates a separate branch and leaves it for inspection and integration; it does not silently merge changes.

The defaults enable up to 16 snapshot worktree workers, up to 64 planned tasks, no depth floor, and plan interpretation. Jev chooses single or planned delegation from the request. Each planned worker sees staged, unstaged and untracked working files; ignored files stay excluded. Code acceptance is followed by root integration and reporting. Apply only the diff from each returned snapshot baseline to the worker branch; the snapshot commit itself is not a root commit.

A complete bounded lookup or mechanical edit can use one account-listed Luna worker without a planner even when the older delegation-cost estimate is negative. This preference shares Gate A's existing Jev request and respects missing context, explicit no-delegation, shape and depth constraints. Workers handle whole outcomes, not each individual file read; the main integrates the result.

Missing source, unknown checks and a worker's self-reported pass never become observed success. Check verification sees native command exits and file-change events; shell-based edits and external editor writes are not established by those events. Encrypted reasoning, media, pending calls or an oversized mandatory context cannot be guessed; these cases use native compaction/handoff behavior. Digest bytes are not measured token or billing savings. Manual and automatic Compact, including Jev dependency selection, are enabled by default. Selection uses at most 16 omitted older successful results and a 1,000ms wait without retry. No key, invalid/secret input, timeout and optional key-access errors retain local extraction. Cancellation and a superseded native generation never apply late results; usage can remain unknown after a timeout. The recent tail, mandatory user text and failure evidence keep their existing rules. Switch `compact.jevEnabled` off for local-only extraction.

## Policy settings

Use `JEV_CODEX_CONFIG=/absolute/codex.json`, otherwise `~/.config/jev-gate/codex.json`. No file is required. Gate/Router settings are loaded for each new prompt; restart the local host for Compact and environment changes.

```json
{
  "gate": {"mode":"auto"},
  "router": {"enabled":true,"model":true,"effort":true,"timeoutMs":800},
  "compact": {"enabled":true,"manual":true,"budgetChars":40000,"jevEnabled":true,"jevTimeoutMs":1000}
}
```

`gate` accepts the shared V5 options, including `mode: "lean"`, depth floors, budgets, checks and `workerIsolation`. Without a model mapping, the adapter selects accessible tiers from live `model/list` descriptions. Explicit `models` entries override only those tiers. Main model and effort routing are both enabled by default. Router has the same directional probability thresholds (upgrade 0.8, downgrade 0.6). `JEV_GATE_MODE` overrides the Gate mode only; `gate.mode: "off"` does not disable Router or Compact.

### Current Codex models and efforts

The router retains the complete native `model/list` catalog and considers every eligible coding candidate, including IDs outside the four role preferences. A malformed or conflicting entry excludes only that candidate; incomplete pagination retains partial discovery and marks it incomplete. Initialization and account changes refresh the bounded catalog without paid probes.

Codex `/model`, `--model`, and ordinary model configuration establish a baseline. They do not permanently pin it. Router defaults to model and effort selection on the same root request, preserving tools, provider, authentication and permissions. Independent switches/pins and a manual mid-turn change take precedence. Effort is scored separately for each candidate; a B answer is never reused for A.

An eligible direct conversation can delegate one bounded subtask without starting a plan. The shared hook reserves that worker before Gate B, applies its model/effort pair, and settles the original execution once. Its result does not complete the whole main request. Background questions stay in the main conversation. If termination or state settlement is uncertain, the returned execution identity supports `jev_agent` status recovery for either foreground or background work; do not start a replacement.

Automatic Astra targets default to **OFF**, including Gate/Lean children even when Router is off. A manual Astra root remains usable. To opt in, set `{"router":{"allowAstra":true}}` in this host’s optional policy file; only boolean true is valid. Claude has separate `routerAllowFable` (combined) and `allowFable` (standalone) settings. No file or model mapping is required for ordinary eligible models.

Observed in Codex CLI 0.159.2 on 2026-09-30:

| Native model | Supported routing efforts |
| --- | --- |
| `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-luna` | low, medium, high, xhigh, max |
| `gpt-5.6-terra`, `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |

Terra, older models and account-specific models remain usable when the live catalog supports them. Availability and defaults depend on your account and host; the table is an observation, not a permanent allowlist. Each effort question offers that candidate’s own supported levels, including max when available. Unknown efforts preserve native settings. Keep, literal none and effort omission remain distinct. Unsupported model/effort combinations are preserved or refused at the automatic-child boundary; the highest effort is not selected simply because it exists.

`ultra` is a native Codex selection. Codex resolves it to the model's ordinary inference effort (observed as `xhigh` or `max`, depending on the model's live catalog), rather than sending a literal `ultra` API value. A native user selection remains authoritative. Automatic Router offers actual provider efforts and excludes `ultra`, which is resolved by Codex before the request reaches the connection; the optional managed connection can pass an official native `ultra` selection. The dashboard records the selected effort, the official host setting and the observed inference request separately; no `ultra` request is fabricated.

For example, this **opt-in** mapping includes Terra:

```json
{
  "gate": {"models": {"fast":"gpt-6-luna","standard":"gpt-5.6-terra","deep":"gpt-6.1-sol","frontier":"gpt-6-astra"}},
  "router": {"model":true}
}
```

Native ChatGPT requests follow the official App Server's workspace backend and residency routing. Credentials stay in the native host and authenticated forwarding path; the connection does not read credential files.

| Environment | Effect |
| --- | --- |
| `JEV_CODEX_WORKSPACE` | Optional explicit Evidence workspace override; otherwise supplied by the native caller |
| `JEV_EVIDENCE_CONFIG` | Authoritative Evidence project/allowed roots/remote settings |
| `TYPESAFE_API_KEY` | Optional explicit key override; otherwise use the shared key entered in the local screen |
| `JEV_GATE_NO_BROWSER=1` | Headless runs: print the local key-entry URL without opening a browser |
| `JEV_GATE_ONBOARDING=0` | Disable automatic key entry for unattended runs |
| `JEV_CODEX_CONFIG` | Absolute Codex policy JSON path |
| `JEV_CODEX_AUTO_CONNECT=0` | Keep Evidence/Output without starting automatic provider integration |
| `JEV_CODEX_ENABLED=0` | Disable hooks and connected automatic policies; the separate Evidence MCP remains available |
| `JEV_CODEX_OUTPUT=off` | Preserve original tool output; lifecycle recording continues |
| `JEV_CODEX_TRACE_DIR` | Absolute recording directory; overrides `JEV_GATE_TRACE_DIR` |
| `JEV_DASHBOARD_NO_OPEN=1` | Suppress the automatic dashboard for unattended runs; manual dashboard prints its URL without opening a browser |
| `JEV_CODEX_UPSTREAM` | Owner-selected OpenAI-compatible Responses base URL; HTTPS or loopback HTTP only |

The optional managed terminal supports native model, sandbox, approval and display options, and rejects options it cannot faithfully forward. Automatic connection preserves a pre-existing custom provider; use an explicit compatible upstream only when you intend it.

Evidence resolves each calling thread’s native workspace, with separate caches and a shared process-wide concurrency bound. The plugin cache is never substituted for the project. `JEV_EVIDENCE_CONFIG` remains an authoritative explicit scope, for example:

```json
{"projectRoot":"/absolute/project","allowedRoots":["src"],"remote":false}
```

Explicit scope changes require MCP restart. Desktop apps do not need to inherit a shell key; the shared local key works there too.

## Live dashboard

The installed plugin opens the shared dashboard automatically, with recording on. Claude Code and Codex appear in one view with host filters; no separate dashboard command or `--debug` flag is required. The execution circuit, real response chart, latest judgment panel, execution timeline and model receipts distinguish selection from observed application. Korean/English and light/dark controls are at the top right.

The settings panel controls recording and automatic opening independently. Both default to on. CLI equivalents are `node <plugin>/dist/cli.mjs recording on|off|status` and `node <plugin>/dist/cli.mjs dashboard on|off|status`. A manual development view remains available with `dashboard --port 4733`. Its terminal must stay running; the automatic dashboard manages its own lifecycle.

Records default to `$XDG_STATE_HOME/jev-gate/codex/traces` or `~/.local/state/jev-gate/codex/traces`. Private atomic metadata records contain no raw prompts, source, tool output, credentials or transcript paths. Missing records mean unknown. No simulated activity or inferred token savings is shown. Old records are not automatically deleted.

If no policy runs, check automatic connection readiness, `/hooks` trust, enablement and key; start a fresh native host if the current host loaded the old provider. The default depth floor is 0, so a fresh turn is eligible for assessment; Jev can still choose direct execution. `doctor` checks package definitions, configured Evidence scope, local connection health and the native `model/list` inventory. It enumerates each routing target and effort and reports invalid configured models or unsupported owned-profile efforts. Use `--json`, `--verbose` and optional `--check-update`. No thread or inference turn is created. An advertised model is not proof of account access, hook execution or product effect.

## Verification and implementation references

```sh
npm run typecheck
npm test
npm run build
claude plugin validate . --strict
JEV_CODEX_E2E=1 npx vitest run tests/codex/runtime.test.ts tests/codex/connection-runtime.test.ts
```

Ordinary tests use fake HTTP/CLI and no credentials. The native runtime suite installs a uniquely named disposable plugin and drives **real Codex processes** with a scripted local Responses provider. It verifies guarded root calls, workers, failed-check rejection, an actual file edit invalidating an earlier check followed by a successful recheck, plan dependencies, Lean packet application, cancellation, denial budgets, read-only permissions, planned-worker worktrees, automatic/manual digest installation, native Output, Evidence, GPT-6/6.1 and Terra model/effort application, and dashboard records; the temporary installation is removed afterwards. The ordinary-native connection test additionally verifies no launcher/workspace export, crash recovery, concurrent sessions, actual Gate worker checks, Lean application, native compaction installation and restoration of owner settings. This establishes those execution paths, not every future host version or measured product savings.

The design was checked against the [official App Server](https://developers.openai.com/codex/app-server), [native hooks](https://learn.chatgpt.com/docs/hooks), [CaMe's native terminal connection](https://github.com/IlBig/CaMe), [jev-router's native Responses integration](https://github.com/gargpratyush/jev-router), [jev-use](https://github.com/shitianfang/jev-use), and [fast-jev-compaction-codex](https://github.com/Li-ship-dot/fast-jev-compaction-codex). These are architectural references, not a copied alternate execution engine. The [0.158.0 loader](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/loader.rs) uses the compatibility manifest and `.mcp.json`; root portable manifests currently omit plugin hooks.

## Responsive background workers

The main thread returns after owned dispatch and can answer new messages while workers run. New conversation turns retain the original job, contract and protected files. Actual native termination triggers acceptance against the original contract; an immediate launch receipt never counts as a result.

The coordinator uses `jev_agent` with `action: "status"` and the returned `agent_id` for a nonblocking result lookup. Explicit user cancellation uses `action: "cancel"`; its acknowledgement alone does not release the reservation. Main interruption does not cancel background work. A lost connection keeps execution unconfirmed and files protected. `run_in_background: false` remains available for advanced synchronous callers.
