# Jev Gate for Codex

Automatic Gate and Router connect to **ordinary native Codex** after the plugin starts. The plugin supplies hooks, an MCP server and an authenticated local connection. Your login, permissions, terminal and official execution engine stay in Codex.

Requires **Node 22.15+**. Automatic connection was tested with **Codex CLI 0.163.0**. The optional managed terminal connection was also tested on 0.158.0. An already open session retains its loaded inference endpoint until a new host loads the automatic settings. Local Codex app/IDE sessions must use this Codex home and support the same native plugin, hook and provider APIs; a remote managed coding session is a separate host.

## Install

From this repository checkout:

```sh
npm ci
npm run build
codex plugin marketplace add "$PWD"
codex plugin add jev-gate@jev-gate-codex
```

For the release archive, extract `jev-gate-codex-<version>.zip`, add that extracted directory as the marketplace, and install the same plugin name. The archive includes its dependencies; it needs no installed `node_modules`. A raw Git checkout must be built first.

Open ordinary `codex` in the project. The installed MCP automatically opens a local **Jev API key** screen when no key is available. Enter the key once; Codex and Claude Code share `~/.config/jev-gate/auth/credentials.json` (or the XDG config location), protected by 0700/0600 permissions. No key is written into a project or Codex's config. Environment keys remain supported and authoritative. The native connection reads newly saved keys without restarting MCP.

Codex supplies the calling thread’s workspace; **no shell export, Jev launcher or policy file is needed**. Enable one Jev Gate installation in `/plugins` and review/trust hooks when the native host requests approval. Installation does not forge hook trust or authenticate the key's API access. A host already running during installation needs a fresh host to load its connection endpoint.

## Automatic connection

The trusted startup hook and installed MCP start one local helper per Codex home. The helper uses the official App Server to execute owned workers and observes ordinary native Responses requests for Router and context usage. Codex’s own compaction runs unchanged, and the Router never rewrites its request. It automatically adds the official `openai_base_url` setting through Codex’s revision-checked configuration API. The built-in `openai` provider, model, effort, authentication and other user settings remain unchanged. An owned global `jev-gate-native` selection from an earlier installation is restored to its original value in the same transaction. Its owned provider table remains as a compatibility alias for native resume of historical threads, points to the same authenticated endpoint and is restored on removal. New installations add no provider table. The endpoint includes a private local capability; this is neither your OpenAI nor Jev key and is never forwarded upstream. A `compact_prompt` marker written by an earlier version is removed, or returned to the owner’s value from before it; any other `compact_prompt` is the owner’s and stays. Unrelated settings and comments are preserved; API keys are never written there. A custom provider is preserved and automatic connection is declined rather than redirected.

Use Codex normally:

```sh
codex
# Native options still work:
codex --model gpt-6.1-sol --sandbox workspace-write
```

If a session was open before installation, start a new native host after connection readiness. The plugin cannot change an endpoint already loaded by that host. Historical provider metadata and a running helper do not prove that the current host loaded the endpoint: its startup observation stays unknown until actual inference traffic is seen. `jev_agent` is installed as an MCP tool; only a current Gate dispatch can start an owned worker. Invalid judgments, missing keys, unsupported input and unknown depth preserve native execution.

The Responses transport uses Codex's official HTTP SSE fallback. Codex 0.163.0 handles an authenticated WebSocket upgrade response of HTTP 426 by selecting SSE for that session, before sending `response.create`. The helper does not prewarm, replay inference, or reconstruct incremental WebSocket state. This adds one local upgrade/fallback on the first connection; it does not establish equal latency to native WebSockets. Ordinary Responses, tool continuations and native compaction retain the host's request semantics.

New ordinary conversations are stored under `openai`, so they share the original history. Earlier conversations saved under `jev-gate-native` remain intact. Codex 0.163.0's native picker filters providers even with `resume --all`; that flag only relaxes directory filtering. To reopen a known legacy conversation through the current connection, use `codex resume <session-id>`. The native App Server can list both histories with `thread/list` and `modelProviders: ["openai", "jev-gate-native"]`. The default picker does not merge them. No history database or rollout is rewritten.

Active plugin clients restart a failed helper. Disabling/removing the plugin restores only settings that still match Jev’s installed values; owner edits are retained. No OS login service is installed. To start without automatic endpoint integration, use `JEV_CODEX_AUTO_CONNECT=0` before plugin startup. Existing native login and configured `openai_base_url` / `OPENAI_BASE_URL` are preserved in the forwarding path. `JEV_CODEX_UPSTREAM` is an explicit compatible endpoint override.

Owned workers use native Codex history so status can recover the exact turn if its completion notification is missed. Their conversations follow Codex's local history retention and are archived after settlement; archiving does not delete them. A collection error preserves the worker reservation and prevents a duplicate managed dispatch, while ordinary tools remain subject to Codex's native permissions.

The older `node <plugin>/dist/cli.mjs codex` managed terminal remains available for explicit connection and diagnostics. It is optional; ordinary use does not require it.

## Feature behavior

| Feature | Automatic connected session |
| --- | --- |
| Gate A | Reads observed native context usage; Jev judges context, cost support and bounded tool work; code chooses direct or one worker and enforces the depth floor |
| Gate B | Adds actual model/effort candidates to the existing Gate B batch; rechecks eligibility before owned dispatch |
| Workers / acceptance | Runs real native Codex workers in the background by default; compares reports with observed command exits and edits. Acceptance is owned by code on both hosts. |
| Router | Uses a nominal actual-ID model choice and candidate-local ordered effort scores; routes the original root request and separates selection, submission and actual response observation |

Native permissions remain authoritative for root and workers. Owned workers inherit the calling tool’s captured native filesystem grants and denies. An unrepresentable permission snapshot refuses dispatch instead of guessing broader access. Workers cannot create another coordinator. Workers run in the caller's working directory by default (`gate.workerIsolation: "none"`). Set `gate.workerIsolation: "worktree"` to run the single worker in a snapshot worktree under those same native permissions. Integrate only the diff from its reported snapshot baseline; do not merge the snapshot commit. Worktree creation failure refuses dispatch.

The defaults run one worker per admitted request with no depth floor. Code acceptance is followed by root integration and reporting.

A complete bounded lookup or mechanical edit can use one account-listed Luna worker even when the older delegation-cost estimate is negative. This preference shares Gate A's existing Jev request and respects missing context, explicit no-delegation, shape and depth constraints. Workers handle whole outcomes, not each individual file read; the main integrates the result.

Missing source, unknown checks and a worker's self-reported pass never become observed success. Check verification sees native command exits and file-change events; shell-based edits and external editor writes are not established by those events.

## Policy settings

Use `JEV_CODEX_CONFIG=/absolute/codex.json`, otherwise `~/.config/jev-gate/codex.json`. No file is required. Gate/Router settings are loaded for each new prompt; restart the local host for environment changes.

```json
{
  "gate": {"mode":"auto"},
  "router": {"enabled":true,"model":true,"effort":true,"timeoutMs":800}
}
```

`gate` accepts the shared V5 options, including depth floors, budgets and checks. Without a model mapping, the adapter selects accessible tiers from live `model/list` descriptions. Explicit `models` entries override only those tiers. Main model and effort routing are both enabled by default. Router has the same directional probability thresholds (upgrade 0.8, downgrade 0.6). `JEV_GATE_MODE` overrides the Gate mode only; `gate.mode: "off"` does not disable the Router. A `gate.mode` or `JEV_GATE_MODE` other than `off|native|auto` turns off the Gate only; the Router keeps its own settings, and `doctor` reports the value. A `compact` section left from an earlier version is ignored.

### Current Codex models and efforts

The router retains the complete native `model/list` catalog and considers every eligible coding candidate, including IDs outside the four role preferences. A malformed or conflicting entry excludes only that candidate; incomplete pagination retains partial discovery and marks it incomplete. Initialization and account changes refresh the bounded catalog without paid probes.

Codex `/model`, ordinary model configuration and an interactive `--model`/`-m` establish a baseline. They do not permanently pin it. A non-interactive `codex exec` run keeps its model and effort on every request. Codex sends nothing that tells `-m`/`-c model_reasoning_effort` apart from `config.toml` defaults, so every `codex exec` request (originator `codex_exec`) is treated as pinned, including one that only inherits the defaults or names the configured model; such a run is not routed, not even from a superseded model to its successor. For the same reason an interactive `-m` cannot be pinned, and an interactive session's start notice says so. Router defaults to model and effort selection on the same root request, preserving tools, provider, authentication and permissions. Independent switches/pins and a manual mid-turn change take precedence. Effort is scored separately for each candidate; a B answer is never reused for A.

An eligible direct conversation can delegate one bounded subtask without starting a plan. The shared hook reserves that worker before Gate B, applies its model/effort pair, and settles the original execution once. Its result does not complete the whole main request. Background questions stay in the main conversation. If termination or state settlement is uncertain, the returned execution identity supports `jev_agent` status recovery for either foreground or background work; do not start a replacement.

Automatic Astra targets default to **OFF**, including Gate children even when Router is off. A manual Astra root remains usable. To opt in, set `{"router":{"allowAstra":true}}` in this host’s optional policy file; only boolean true is valid. Claude has separate `routerAllowFable` (combined) and `allowFable` (standalone) settings. No file or model mapping is required for ordinary eligible models.

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
| `TYPESAFE_API_KEY` | Optional explicit key override; otherwise use the shared key entered in the local screen |
| `JEV_GATE_NO_BROWSER=1` | Headless runs: print the local key-entry URL without opening a browser |
| `JEV_GATE_ONBOARDING=0` | Disable automatic key entry for unattended runs |
| `JEV_CODEX_CONFIG` | Absolute Codex policy JSON path |
| `JEV_CODEX_AUTO_CONNECT=0` | Start without automatic endpoint integration |
| `JEV_CODEX_ENABLED=0` | Disable hooks and connected automatic policies |
| `JEV_CODEX_TRACE_DIR` | Absolute recording directory; overrides `JEV_GATE_TRACE_DIR` |
| `JEV_DASHBOARD_NO_OPEN=1` | Suppress the automatic dashboard for unattended runs; manual dashboard prints its URL without opening a browser |
| `JEV_CODEX_UPSTREAM` | Owner-selected OpenAI-compatible Responses base URL; HTTPS or loopback HTTP only |

The optional managed terminal supports native model, sandbox, approval and display options, and rejects options it cannot faithfully forward. Automatic connection preserves a pre-existing custom provider; use an explicit compatible upstream only when you intend it.

Desktop apps do not need to inherit a shell key; the shared local key works there too.

## Live dashboard

The installed plugin opens the shared dashboard automatically, with recording on. Claude Code and Codex appear in one view with host filters; no separate dashboard command is required. The execution circuit, real response chart, latest judgment panel, execution timeline and model receipts distinguish selection from observed application. Korean/English and light/dark controls are at the top right.

The settings panel controls recording and automatic opening independently. Both default to on. CLI equivalents are `node <plugin>/dist/cli.mjs recording on|off|status` and `node <plugin>/dist/cli.mjs dashboard on|off|status`. A manual development view remains available with `dashboard --port 4733`. Its terminal must stay running; the automatic dashboard manages its own lifecycle.

Records default to `$XDG_STATE_HOME/jev-gate/codex/traces` or `~/.local/state/jev-gate/codex/traces`. Private atomic metadata records contain no raw prompts, source, tool output, credentials or transcript paths. Missing records mean unknown. No simulated activity or inferred token savings is shown. Trace records follow the shared 48-hour retention policy.

If no policy runs, check automatic connection readiness, `/hooks` trust, enablement and key; start a fresh native host if the current host loaded the old endpoint. The default depth floor is 0, so a fresh turn is eligible for assessment; Jev can still choose direct execution. `doctor` checks package definitions, local connection health and the native `model/list` inventory. It enumerates each routing target and effort and reports invalid configured models or unsupported owned-profile efforts. Use `--json`, `--verbose` and optional `--check-update`. No thread or inference turn is created. An advertised model is not proof of account access, hook execution or product effect.

## Verification and implementation references

```sh
npm run typecheck
npm test
npm run build
claude plugin validate . --strict
JEV_CODEX_E2E=1 npx vitest run tests/codex/runtime.test.ts tests/codex/connection-runtime.test.ts tests/codex/native-history-runtime.test.ts
```

Ordinary tests use fake HTTP/CLI and no credentials. The native runtime suite installs a uniquely named disposable plugin and drives **real Codex processes** with a scripted local Responses provider. It verifies unguarded root calls, workers, failed-check rejection, an actual file edit invalidating an earlier check followed by a successful recheck, cancellation, read-only permissions, unrouted native compaction, GPT-6/6.1 and Terra model/effort application, and dashboard records; the temporary installation is removed afterwards. The ordinary-native connection test additionally verifies no launcher/workspace export, crash recovery, concurrent sessions, actual Gate worker checks, an unrouted native compaction, removal of an earlier version's compaction marker and restoration of owner settings. The native history test lists both provider histories and resumes each exact ID through the built-in endpoint with its earlier turn intact. This establishes those execution paths, not every future host version or measured product savings.

The design was checked against the [official App Server](https://developers.openai.com/codex/app-server), [native hooks](https://learn.chatgpt.com/docs/hooks), [CaMe's native terminal connection](https://github.com/IlBig/CaMe), [jev-router's native Responses integration](https://github.com/gargpratyush/jev-router), and [jev-use](https://github.com/shitianfang/jev-use). These are architectural references, not a copied alternate execution engine. The [0.158.0 loader](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/loader.rs) uses the compatibility manifest and `.mcp.json`; root portable manifests currently omit plugin hooks.

## Responsive background workers

The main thread returns after owned dispatch and can answer new messages while workers run. New conversation turns retain the original job, contract and worker identity. Actual native termination triggers acceptance against the original contract; an immediate launch receipt never counts as a result.

The coordinator uses `jev_agent` with `action: "status"` and the returned `agent_id` for a nonblocking result lookup. Explicit user cancellation uses `action: "cancel"`; its acknowledgement alone does not release the reservation. Main interruption does not cancel background work. A lost connection keeps execution unconfirmed and prevents a duplicate managed dispatch. `run_in_background: false` remains available for advanced synchronous callers.
