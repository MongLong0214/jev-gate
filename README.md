<div align="center">

<img src="./assets/readme/jev-gate-logo.svg" width="460" alt="jev-gate">

# jev-gate

### Not every coding task needs your best model.

Jev-powered model routing for Claude Code.<br>
An experiment in using frontier intelligence for the hard parts—not every part.

[![CI](https://github.com/MongLong0214/jev-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/MongLong0214/jev-gate/actions/workflows/ci.yml)
[![V4 local plugin](https://img.shields.io/badge/V4-local%20plugin%2C%20headless--verified-58A6FF)](#try-v4)
[![Savings not established](https://img.shields.io/badge/savings-not%20established-D29922)](#results)
[![Node 22+](https://img.shields.io/badge/node-22%2B-3FB950)](#try-v4)

[The idea](#the-idea) · [How V4 works](#how-v4-works) · [Try V4](#try-v4) · [What is verified](#what-is-verified-and-what-is-not) · [Results](#results) · [Build with us](#build-with-us)

</div>

> **Status · September 18, 2026.** V4 task-boundary routing is **implemented on `main` as a local plugin** and its native
> integration was **observed on Claude Code 2.1.275 (headless `-p`, Claude.ai subscription login)**. Interactive-session
> behavior, Opus/Fable routing branches and any cost or quality benefit are **not established**; see
> [What is verified](#what-is-verified-and-what-is-not) and [Results](#results); the first V4 run found that the gate **did not engage** on four small jobs, and forced delegation cost more. Contract: [#9 PRD](https://github.com/MongLong0214/jev-gate/issues/9) → [#10 ADR](https://github.com/MongLong0214/jev-gate/issues/10).

## The idea

You ask your coding agent:

> “Build a space-simulation game.”

That is one request, but many different jobs: work out the physics, design the state model, implement camera controls, connect the HUD, and test the result.

<p align="center">
  <img
    src="./assets/readme/hero.svg"
    width="760"
    alt="One user job breaks into four pieces of work — simulation architecture, camera controls, HUD wiring and regression tests. Each is evaluated at the gate on its own. The architecture work goes to a frontier model; the other three go to the cheaper model."
  >
</p>

**Why give all of those jobs the same model?**

`jev-gate` explores a different default: **Sonnet coordinates. Jev evaluates the next delegated task. A suitable Claude model does the work.**

The question is not just *“Is this project hard?”* It is *“Does this next piece of work need a frontier model?”*

We are not aiming for hundreds of tiny agents. The useful unit is a coherent outcome—camera controls and their tests, for example—not each file read. Handoffs, repeated exploration, and integration all have costs. The gate only helps if it saves more than it adds.

## How V4 works

<p align="center">
  <img
    src="./assets/readme/v4-flow.svg"
    width="860"
    alt="V4 flow. The request goes to a Sonnet main session that understands, coordinates and integrates. A small task finishes directly with no Jev call. A delegated task goes to a coding worker or a read-only planner, where a PreToolUse Agent hook lets Jev evaluate that one task once and select Sonnet, Opus or Fable. The result returns to Sonnet, which integrates it and continues."
  >
</p>

The selected model in the diagram is illustrative, not a fixed assignment for any feature. Account access and actual model resolution still decide what runs.

**Native Claude Code, not another agent framework.** Two plugin agents, `jev-gate:worker` (Sonnet by default; Read/Grep/Glob/Edit/Write/Bash) and `jev-gate:planner` (Opus by default; read-only), plus four command hooks. No proxy, MCP server, daemon, or second Claude login.

**A task handoff, not a generated rewrite.** `UserPromptSubmit` adds fixed coordinator guidance and never calls Jev. When Sonnet delegates a new, foreground, unpinned task to an owned role, `PreToolUse:Agent` sends that task's description and prompt to Jev once, validates the typed answers, and returns the **complete original Agent input** with only two changes: a configured `model` and a short hint appended after the original prompt. It never approves a tool call, changes permissions, or shortens the request.

**Uncertainty means abstain.** `needs_context`, `abstain`, a tie, or confidence below the floor preserves the original invocation. Low confidence never becomes an automatic Fable call. Explicit model arguments are caller pins and bypass the gate.

<details>
<summary><strong>Technical boundary: exactly where the gate runs</strong></summary>

Eligible: mode `auto`; a root-session `PreToolUse` for the `Agent` tool; `subagent_type` exactly `jev-gate:worker` or `jev-gate:planner`; a string description and non-blank prompt; explicit foreground; **no `model` property** (null or empty still counts as a pin); none of `resume`, `agentId`, `name`, `team_name`, `isolation`; no concrete `CLAUDE_CODE_SUBAGENT_MODEL` / `_FORCE`; `CLAUDE_CODE_FORK_SUBAGENT` not `1`; prompt ≤ 64 KiB, request ≤ 128 KiB, serialized output ≤ 512 KiB.

Observed on Claude Code 2.1.275: with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` the host runs Agent calls in the foreground and **omits** `run_in_background` from the hook input, so the plugin treats an absent field as foreground only under that launch profile. Without the profile, interactive sessions run fork mode, calls carry no foreground flag, and V4 preserves them (no routing).

Not touched: another plugin's or built-in agents, resumes and `SendMessage`, background/fork/team calls, child-session calls, custom `--agent` main sessions, and anything the main session does directly. Foreground guidance is not a scheduler or a file lock.

Failure of any kind — missing key, timeout (one 3 s deadline covering headers and body), HTTP 401/422/429/529, invalid response, invalid config, oversized input — preserves the native call with a fixed stderr code. There are no retries.

</details>

## Try V4

Requirements: **Node.js 22+**, **official Claude Code signed in with a Claude.ai subscription** (the recorded checks used 2.1.275 on macOS), and a **TypeSafe API key** for `auto` mode. Start on a disposable project. Read the [data disclosure](#your-login-your-data-your-choice) first.

```sh
git clone https://github.com/MongLong0214/jev-gate.git
cd jev-gate
npm ci
npm run build
PLUGIN_DIR="$PWD"

# Set TYPESAFE_API_KEY in this shell with your local secret workflow — never in chat, an issue or a committed file.
# The hook does not load a project's .env.
JEV_GATE_MODE=auto node dist/cli.js doctor      # diagnostics only, no inference

cd /path/to/your/project
JEV_GATE_MODE=auto \
CLAUDE_CODE_FORK_SUBAGENT=0 \
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 \
claude --model sonnet --plugin-dir "$PLUGIN_DIR"
```

Type normally. There is no `/jev` command. The two environment settings request the foreground, non-fork launch profile the plugin is verified against; they are scoped to this command and are not written into your settings.

| Mode | What runs | Jev |
|---|---|---|
| `off` (default) | nothing: no guidance, no routing, no trace writes. Loaded agent definitions still exist — remove `--plugin-dir` and start a new session for the absent-plugin condition | 0 |
| `native` | coordinator guidance + owned roles; the main session may pin per-call models | 0 |
| `auto` | same hierarchy; eligible unpinned owned calls are evaluated | ≤ 1 request per eligible call |

Optional config at `~/.config/jev-gate/config.json` (or `JEV_GATE_CONFIG`), `JEV_GATE_MODE` overrides the mode only, and `JEV_GATE_MODE=off` returns before any file is read:

```json
{ "version": 4, "mode": "off", "jevModel": "jev-1.13.0", "requestDeadlineMs": 3000, "routeConfidenceFloor": 0.8,
  "models": { "sonnet": "sonnet", "opus": "opus", "fable": "fable" } }
```

A V3 file (`version: 3`, `uncertainTier`, `opusModel`, `frontierModel`, mode `enrich`) is rejected with this sample; the plugin never rewrites your file. Model mappings choose what a patch proposes; they grant no account access and do not change a role's default when the gate abstains. `routeConfidenceFloor` is an uncalibrated policy value.

A local archive for a machine without a checkout: `npm run pack` writes `dist-pack/jev-gate-<version>.zip` (compiled hook, manifest, hooks, agents, docs); load it with `--plugin-dir /path/to/jev-gate-<version>.zip`.

## What is verified, and what is not

Recorded observations are in [`bench/results/v4-host-2026-09-18/`](bench/results/v4-host-2026-09-18/). Host: Claude Code 2.1.275, macOS, Claude.ai team subscription, headless `claude -p` under the launch profile above.

| Observed | Evidence |
|---|---|
| Plugin loads; `jev-gate:worker` and `jev-gate:planner` discovered once each; four hooks registered | `system/init`, `/hooks` counts via doctor |
| A full-input patch changes the child's model and delivers the appended text; role and other fields survive | test-only deterministic hook: `resolvedModel = claude-haiku-4-5-20251001`, canary repeated by the child |
| Native permissions are unchanged by a patch | a `Write(**/forbidden/**)` deny rule still denied the child; the Agent call still reported `completed`, and no `PostToolUseFailure` fired |
| Real routing path: guidance → skip for Explore (`role_not_owned`) → skip for a pinned call (`model_pinned`) → one Jev request → patch → child on the patched model → task solved | real plugin in `auto` with a real key; 1,265 Jev input tokens, 678 ms, `route sonnet .99` |
| Keys and prompt bodies stay out of traces and stderr | whitelisting in the hook; offline tests |

| Not verified here | Why it matters |
|---|---|
| Interactive TUI sessions | fork mode and agent-teams behave differently; `-p` was the only exercised host mode |
| A Jev decision selecting Fable, and a child actually running on Fable | the diagnostic run produced one Opus selection that ran on `claude-opus-5[1m]`; no Fable selection occurred |
| A user “do not delegate” instruction against a contrary recommendation | the classifier agreed with the main session in the exercised runs |
| Resumes, `SendMessage`, other plugins' agents, `--agent` sessions | handled by code paths and offline tests only |
| Any cost, runtime or quality benefit | see [Results](#results) |

`doctor` reports configuration and environment issues (auth method, model overrides, launch profile, key presence, role frontmatter). It is not proof that patching or model access works on your host.

## Results

### The first benchmark changed the design (V3, September 17)

**Our first gate lost to plain Sonnet. We kept the result.**

<p align="center">
  <img
    src="./assets/readme/pilot.svg"
    width="760"
    alt="Estimated cost per run across four configurations. Always-Fable on the original request cost $2.39 and passed 3 of 4; always-Fable on the Jev-enriched request cost $2.50 and passed 3 of 4; plain Sonnet with the plugin absent cost $0.58 and passed 4 of 4; Sonnet behind the V3 Jev gate cost $1.42 and passed 4 of 4."
  >
</p>

| Configuration | Passed | Estimated total cost | Mean runtime |
|---|---:|---:|---:|
| Fable, original request | 3/4 | $2.3940 | 50.9 s |
| Fable, Jev-enriched request | 3/4 | $2.4951 | 51.9 s |
| **Sonnet, plugin absent** | **4/4** | **$0.5781** | **22.2 s** |
| Sonnet, V3 Jev gate | 4/4 | $1.4242 | 41.5 s |

One low-confidence decision escalated to Fable and dominated the overhead. That policy is gone in V4: uncertainty preserves the native call. [Published report](bench/results/run-1-2026-09-17/report.md) · [Original checker report](bench/results/run-1-2026-09-17/report.checker-v1.md) · [What changed](https://github.com/MongLong0214/jev-gate/issues/6)

### V4 evaluation

V4 is compared on complete coding jobs under five arms: `sonnet_native` (plugin absent), `native_hierarchy` (same roles, Sonnet picks models), `jev_hierarchy` (Jev picks eligible tasks), `frontier_native` (Fable main, plugin absent), and `fixed_hierarchy` (same hierarchy, content-blind role defaults). The primary comparison is **Jev hierarchy versus native hierarchy**; beating the expensive default alone proves nothing.

Four new jobs live in [`bench/v4/`](bench/v4/README.md): a localized bug fix with regression tests, a cross-file feature touching model/serialization/view, a compound simulation with deterministic time, camera and HUD, and an async error-propagation bug. Each has a broken start, a trusted behavior checker, and a reference that passes it.

**Run 1 — product policy as shipped (September 18, 2026).** 4 jobs × 5 arms, one repetition, seed 42, Claude Code 2.1.275, Claude.ai team subscription, headless. All 20 cells completed; every arm passed 4/4 after a checker correction (below). Tables: [`bench/results/v4-run-1-2026-09-18/`](bench/results/v4-run-1-2026-09-18/).

| Arm | Passed | Fable tokens | Claude est. | Jev est. | Runtime (4 jobs) |
|---|---:|---:|---:|---:|---:|
| `frontier_native` | 4/4 | 1,228,003 | $4.448 | $0 | 449 s |
| `sonnet_native` | 4/4 | 0 | $1.116 | $0 | 301 s |
| `native_hierarchy` | 4/4 | 0 | $1.059 | $0 | 274 s |
| `fixed_hierarchy` | 4/4 | 0 | $1.046 | $0 | 250 s |
| `jev_hierarchy` | 4/4 | 0 | $1.063 | **$0** | 252 s |

**The gate never engaged.** In all twelve hierarchy cells the plugin loaded, both roles were discovered and the coordinator guidance was injected, but the Sonnet coordinator delegated **zero** tasks: it did every job directly. The three hierarchy arms are therefore the same execution, and their differences from each other (−2 % to +8 %) and from plain Sonnet (≈5 % cost, 9–17 % runtime) are run-to-run variance plus one injected guidance block. The 76 % cost reduction against `frontier_native` comes from starting on Sonnet, not from Jev. On jobs of this size and in headless mode, **V4 adds nothing beyond native Sonnet because it is never asked to decide.** Primary comparison `jev_hierarchy` vs `native_hierarchy`: 4/4 vs 4/4, cost −0.4 %, runtime +8.2 %, validity ok.

The original checker had mis-scored three `job-queue` candidates whose regression tests *hang* (rather than fail) against the unfixed source; hanging is not passing, so the checker was corrected, every candidate was re-scored, and both report revisions are kept.

**Diagnostic — forced delegation (same day).** To observe the gate path at all, the same four jobs were re-run with an explicit user instruction to delegate the implementation to `jev-gate:worker` without a model argument (`bench/v4/diagnostic-delegate.json`), `jev_hierarchy` vs `native_hierarchy` only. This measures the mechanism, not the product policy. Tables: [`bench/results/v4-diag-delegate-1-2026-09-18/`](bench/results/v4-diag-delegate-1-2026-09-18/).

| Job | Jev route (confidence) | Decision | Worker ran on | jev / native cost | jev / native time |
|---|---|---|---|---:|---:|
| cart-total | sonnet (.99) | patch → sonnet | claude-sonnet-5 | $0.31 / $0.31 | 75 s / 80 s |
| todo-priority | opus (.35; p .52/.48) | preserve (below floor) | claude-sonnet-5 (default) | $0.38 / $0.34 | 102 s / 93 s |
| space-sim | opus (.90) | patch → opus | **claude-opus-5[1m]** | $1.35 / $0.69 | 282 s / 233 s |
| job-queue | sonnet (.58) | preserve (below floor) | claude-sonnet-5 (default) | $0.35 / $0.38 | 82 s / 107 s |

All eight cells passed. Four eligible calls, four Jev requests (634–861 ms, 12,644 input tokens ≈ $0.0005 total), two patches, two abstentions, zero target/actual model mismatches, hints delivered on both patched calls. Totals: `jev_hierarchy` $2.374 and 541 s versus `native_hierarchy` $1.724 and 513 s — **the Jev arm cost 38 % more for the same four passes**, entirely from the one Opus escalation on `space-sim`, which the Sonnet worker also solved. Two of four routing decisions abstained at the .8 floor.

**Reading.** The native boundary and the routing mechanism work as specified and were observed end to end, including an actual Opus child. The product hypothesis is **not supported by this evidence**: under the shipped policy the gate did not engage, and when forced to engage it selected a more expensive model once without a quality gain. This is one repetition on four small development jobs, so it is exploratory; it does not show that Jev cannot help on larger jobs where Sonnet would fail or delegate on its own.

<details>
<summary><strong>What would change the picture</strong></summary>

Jobs large enough that the coordinator delegates on its own (or that Sonnet fails), repetitions to separate policy from variance, and a frozen-boundary probe of `space-sim` comparing Opus and Sonnet workers from the same state. Changing the coordinator guidance to delegate more, or lowering the floor, would be policy tuning and must be developed on separate data and declared before the next held-out run.

</details>

<details>
<summary><strong>Measurement rules</strong></summary>

Rows come from the saved plan, not from the files that survived: a missing cell is a missing record, never “not started” or cost zero. Totals include failures and timeouts; when any consumption is unknown the total is null and the known subtotal is shown beside it. The complete-case subset is a labeled diagnostic, never the headline. A timeout is not time-to-success. Whole-tree `modelUsage` is the accounting source; Claude dollars are API-equivalent estimates, not subscription invoices; Jev dollars are list price × input tokens with the price frozen per run. Whole jobs are the unit; children of one job are clustered observations. Same pass counts are not equivalence.

```sh
node dist/bench/run.js --cases bench/v4/cases.json --out /outside/repo/run                       # plan: stdout only, no writes, no inference
node dist/bench/run.js --cases bench/v4/cases.json --out /outside/repo/run --execute --max-sessions 20
node dist/bench/report.js --run /outside/repo/run                                                  # reads files only; new report revision each time
node dist/bench/run.js --regrade --cases bench/v4/cases.json --out /outside/repo/run               # re-score saved snapshots, 0 model calls, history kept
```

Execute refuses to start without a verified Claude.ai subscription login, with API-key/gateway env active, with a concrete subagent-model override, without `TYPESAFE_API_KEY` when the Jev arm is planned, or into an existing output directory. `--arms a,b` runs a declared subset; unrun controls limit the conclusion. Raw run folders contain task text and stay local.

</details>

## Your login. Your data. Your choice.

Claude runs through its existing official login. `jev-gate` does not implement OAuth, extract or refresh tokens, or require `WORKER_API_KEY`, `FRONTIER_API_KEY`, or an Anthropic API connection. Jev is a separate hosted service and needs **`TYPESAFE_API_KEY`**; its charges and limits are separate from your Claude subscription.

**In `auto` mode the delegated Agent prompt and description are sent to TypeSafe** together with fixed evaluation criteria. That text can include source excerpts, file names, and earlier user constraints. The hook does not independently upload your repository, transcript or environment, but text supplied by the caller can contain sensitive information. **Only enable `auto` for data you are authorized to send.** There is no automatic secret-scrubbing or zero-retention guarantee. `native` and `off` send nothing.

Optional local traces (`JEV_GATE_TRACE_DIR`) hold per-phase JSON with prompt lengths and hashes, decisions, Jev usage and the child's reported model; they never contain the key or the prompt body, are written 0700/0600, and are not uploaded. Delete the directory to remove them.

## Build with us

**The most useful contribution is a real coding task—not another optimistic percentage.** Share a sanitized task, what a correct result should do, the host/model versions, and what actually happened. Easy tasks that were over-escalated and expensive tasks that did not benefit from a stronger model are both useful.

[Report a finding](https://github.com/MongLong0214/jev-gate/issues/new) · [Roadmap](https://github.com/MongLong0214/jev-gate/issues/9)

Implementation follows **[#9 PRD](https://github.com/MongLong0214/jev-gate/issues/9) → [#10 ADR](https://github.com/MongLong0214/jev-gate/issues/10) → [#11](https://github.com/MongLong0214/jev-gate/issues/11)–[#18](https://github.com/MongLong0214/jev-gate/issues/18)**. Issues #1–#8 preserve earlier work; their closure does not certify inherited defects as fixed. Contributor rules are in [AGENTS.md](AGENTS.md).

```sh
npm ci
npm run typecheck
npm test            # offline: fake HTTP, fake CLI, temp dirs; no key or login
npm run build
claude plugin validate . --strict
```

## Research and references

The [research review in ADR #10](https://github.com/MongLong0214/jev-gate/issues/10) connects routing, execution-state information, simple baselines, and coordination overhead to the design. Results from other models and benchmarks are not forecasts for this plugin.

[Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Native subagents](https://code.claude.com/docs/en/sub-agents) · [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) · [TypeSafe System One API](https://docs.typesafe.ai/api.md) · [Confidence](https://docs.typesafe.ai/confidence.md) · [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)

## License

A license has not yet been selected. No license file is present in this revision.

---

**Keep the hard thinking. Question the expensive default.**
