<div align="center">

<img src="./assets/readme/jev-gate-logo.svg" width="460" alt="jev-gate">

# jev-gate

### Not every coding task needs your best model.

Jev-powered model routing for Claude Code.<br>
An experiment in using frontier intelligence for the hard parts—not every part.

[![CI](https://github.com/MongLong0214/jev-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/MongLong0214/jev-gate/actions/workflows/ci.yml)
[![V5 local plugin](https://img.shields.io/badge/V5-local%20plugin%2C%20host--verified-58A6FF)](#try-v5)
[![Savings not established](https://img.shields.io/badge/savings-not%20established-D29922)](#results)
[![Node 22+](https://img.shields.io/badge/node-22%2B-3FB950)](#try-v5)

[Install](#install) · [The idea](#the-idea) · [lean (new)](#lean--a-second-separate-mode-in-development) · [How V5 works](#how-v5-works-legacy-routing-modes) · [Try V5](#try-v5) · [What is verified](#what-is-verified-and-what-is-not) · [Results](#results) · [Build with us](#build-with-us)

</div>

> **Status · September 28, 2026 · v0.5.0.** V5 turns one request into a judged workflow: Jev decides the execution
> shape, a strong read-only planner decomposes the job, a Sonnet coordinator runs the plan behind an execution guard,
> and Jev picks a tier for every planner and worker dispatch. The mechanism was **observed end to end on Claude Code
> 2.1.275/2.1.276** (headless and interactive). **No cost or time benefit is established for the gate itself**: the
> whole-job comparison was stopped after one cell for budget reasons, and in that cell every task routed to the same
> tier. Three smaller Function Hooks plugins have since shipped alongside it — an extractive compactor, a model/effort
> router and a Vitest output folder — and a read-only evidence MCP tool ships as a release asset; each has its own
> evidence and limits, in [Install](#install) and its own README. See
> [What is verified](#what-is-verified-and-what-is-not) and [Results](#results). Contract:
> [#21 PRD](https://github.com/MongLong0214/jev-gate/issues/21) → [#22 ADR](https://github.com/MongLong0214/jev-gate/issues/22).
> Release: [v0.5.0](https://github.com/MongLong0214/jev-gate/releases/tag/v0.5.0). Next work and current state:
> [HANDOFF.md](HANDOFF.md).

## Install

The repository is its own Claude Code plugin marketplace. In a Claude Code session:

```text
/plugin marketplace add MongLong0214/jev-gate
/plugin install jev-gate-compact@jev-gate
```

| Plugin | What it does | Needs |
|---|---|---|
| `jev-gate-compact` | Answers auto compactions with an extractive digest and the recent tail: no summarizer request, milliseconds instead of a minute. Calls no Jev. [README](mods/compact/README.md) | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` |
| `jev-gate-router` | Chooses the main thread's effort and a subagent's model and effort from one Jev assessment each; native on any doubt. The main thread's model stays native. [README](mods/router/README.md) | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, a TypeSafe key |
| `jev-gate-output` | Folds runs of identical lines in a passing Vitest log the host saved to a file, so the whole run reaches the model with exact counts instead of a 2 KB preview. Calls no Jev. [README](mods/output/README.md) | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` |
| `jev-gate` | The orchestration gate described below, built from the tagged release. | Node.js 22+, a TypeSafe key, `JEV_GATE_MODE` |

Every plugin is off after install. The three Function Hooks plugins take their options in `/plugin` (or
`claude plugin install <plugin>@jev-gate --config enabled=true`), and the host loads them only when
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is in its environment, for example under `env` in `~/.claude/settings.json`.
`jev-gate` reads its mode from `JEV_GATE_MODE` or `~/.config/jev-gate/config.json` ([Try V5](#try-v5)).

`jev-gate-evidence`, one read-only MCP tool that returns exact source windows (and, with remote on, lets Jev fold
clearly unrelated ones), is not in the marketplace: download its archive from a release and load it with `--plugin-dir`
([README](plugins/evidence/README.md)).

A plugin changes only when a release raises its version, and `main` takes only releases. To update, run
`/plugin marketplace update jev-gate` and then `claude plugin update <plugin>@jev-gate`, or turn on auto-update for the
marketplace under **Marketplaces** in `/plugin`. [CHANGELOG](CHANGELOG.md) lists what each release changed.

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

## `lean` — a second, separate mode (in development)

`off`, `native` and `auto` below are the **legacy routing modes**: Gate A, a planner, a task graph, tier routing and a
root guard. `lean` shares none of that machinery. It is additive, off by default, and implemented but **not measured**.

The hypothesis it tests is narrow: on an ordinary request in a session that already has history, Jev picks which
complete prior interaction groups a fresh worker still needs, and the hook hands that packet to **one**
`jev-gate:executor` running on your own inherited model, with your auto-compact untouched.

```text
your request (normal auto-compact ON)
 -> local checks: mode, key, readable host transcript, mandatory layer fits, optional groups exist
 -> no optional evidence, no key, unknown source: native, and zero requests
 -> ONE batched Jev request: work shape, handoff scope, keep/omit per group
 -> short/unclear/needs-context/forbidden/nothing-actually-omitted: native, and the call still cost what it cost
 -> otherwise: one short recommendation carrying an opaque marker (never the packet itself)
 -> you may ignore it; if the root does call the executor, PreToolUse patches that one call's prompt
 -> the executor implements and checks normally and reports in prose; the root integrates as usual
```

What that does and does not mean:

- **Jev selects existing history. It does not summarise, delete or rewrite anything.** Your transcript, your compact
  summary, your CLAUDE.md and your permissions are untouched.
- **Your current words, every active human turn and the whole supported compact summary are always carried.** Whether
  they fit is decided from their actual bytes, not from a post-compact token total (that number includes the static
  prefix). An exact reference you make — a backticked name, a quoted string, a path — that matches exactly one earlier
  interaction makes that whole interaction mandatory too; an ambiguous or dangling one is never guessed at.
- **Model inheritance is not free context.** A custom subagent has its own system prompt and may not have the parent's
  auto-memory, already-invoked skills or root-only tools. The first root turn and the final integration still happen,
  and the worker loads its own prefix.
- **A smaller packet is not a saving.** Fewer packet bytes, more Jev calls or fewer root turns establish nothing.
  Missing history can cause rereads and repairs that cost more than was saved. No number here is measured yet.
- **The comparisons are ordinary Claude with normal auto-compact (`native_auto`) and a deterministic recency packet
  (`recent_packet`), not a strawman.** See [#29](https://github.com/MongLong0214/jev-gate/issues/29).
- **Explicit `lean` is consent to the documented export.** The current request, the mandatory layer and the enumerated
  groups go to TypeSafe. Credential screening is a conventional local pattern check, best effort — not universal
  protection and not a zero-retention guarantee. If your request or a required turn screens as a credential, nothing
  is sent and the turn stays native; an optional group that screens is withheld and counted.
- **A ban on delegation is respected through the confidence floor, not reliably recognised.** In a small probe, an
  explicit "do not hand this to another worker" in the request scored `forbidden` at 0.59 at most, and lost to
  `self_contained` once. It stayed native only because no answer reached the 0.8 action floor
  ([probe](bench/results/v5-lean-scope-probe-2026-09-25/)). For work that must not be delegated, leave `lean` off.
- **The recommendation can be ignored, and nothing blocks the root if it is.** There is no guard and no deny-list in
  `lean`.

```sh
npm run build
node scripts/pack.mjs dist-pack --profile lean     # one executor, the lean hook set
JEV_GATE_MODE=lean node dist/cli.js doctor

cd /path/to/your/project
JEV_GATE_MODE=lean CLAUDE_CODE_FORK_SUBAGENT=0 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 \
claude --model sonnet --plugin-dir "$PLUGIN_DIR"
```

Load one profile at a time: the lean artifact ships only `agents/executor.md`, and selecting a legacy mode there is
diagnosed (`profile_mode_mismatch`) rather than starting a guard for roles it does not install.

Specification: [#21 PRD](https://github.com/MongLong0214/jev-gate/issues/21),
[#22 ADR](https://github.com/MongLong0214/jev-gate/issues/22),
[#33](https://github.com/MongLong0214/jev-gate/issues/33)–[#36](https://github.com/MongLong0214/jev-gate/issues/36),
[#29 measurement](https://github.com/MongLong0214/jev-gate/issues/29).

## How V5 works (legacy routing modes)

One request becomes a judged workflow. Jev is asked at every decision point, because a judgment costs about $0.0001 and
returns in under a second; the expensive models are asked only where a decision is hard.

```text
your request
  └─ Gate A  Jev: how many tool calls would this take? code: does delegating it pay at this depth?
       ├─ direct        → Sonnet works normally, no plan, no guard
       ├─ single        → one worker carries the request itself, no planner (the default for one outcome)
       └─ orchestrated  → strong planner (Opus, or Fable when Jev says the uncertainty warrants it)
                            reads the repository and returns a specification per task: interfaces, data shapes,
                            invariants, the files it inspected, and what it could not resolve
                          Sonnet coordinates: it dispatches ready tasks and integrates results, but cannot
                            implement the job itself while orchestration is active
                            └─ Gate B  Jev: which tier runs this task? fast · standard · deep · frontier
                            └─ a deterministic check: does the reply report every required check as passed?
                          a broken planning assumption returns to the planner, not to improvisation
```

**Sonnet runs the plan; it does not invent the important parts of it.** V4 left decomposition to the coordinator, and on
four small jobs it never delegated at all ([results](#results)). V5 moves that decision to Jev and the planner. The
planner may add optional `spec`/`uncertainty` context per task; neither field is required by the schema. It may also
list `main_session_steps` (#48) alongside the plan: steps that need an OS permission, a live app, an interactive login
or a physical device, which no headless worker can do — the coordinator context repeats these on plan acceptance and
again when the last task is accepted, but a step is never dispatched and never gates a task's readiness.

**Code owns acceptance.** A worker's result unlocks its dependents only when the reply reports every required check of
its task contract as passed. That is a deterministic check, not a Jev call — the normal path no longer makes a Gate C
HTTP request. Since 0.4.0 (`verifyWorkerChecks`, on by default) each reported pass of a required check is also
compared with the last call of its command in the worker's own transcript. A call counts when it contains the check's
own shell segments in order and nothing around them can decide the exit status in their place: `echo npm test`,
`true || npm test`, `npm test || true` and `npm test; echo done` are not runs of `npm test`, while
`cd pkg && npm test -- --run` is. A check whose last run failed is refused, and so is a pass the gate cannot see: no
passing run in the transcript, none in the last 8 MiB of a longer one, no transcript at all, or a required check with
no command (`unobserved`). A host whose transcript layout moved therefore gets every reported pass back as incomplete,
with the reason saying the transcript could not be read. A pass an edit came after is recorded as `stale` and refuses
nothing. On the single shape, where the worker names each check by the command it ran, a worker that changed files and
reports no passing check is not accepted either, and a check is named in traces by its position (`#1`), never by the
command. It sees only how the host marked each Bash
call — a command piped into `tail` exits with `tail`'s status, and an unmarked result is unknown — so an accept is
still not independent proof that the code works; historical Gate C `result_*` records from before this change are
still read as history.

**Uncertainty preserves the default.** A tie, a low confidence, an abstention or any HTTP failure keeps the call that was
already going to happen. A tier above standard additionally requires a concrete upgrade basis in the task itself —
`fast` is below `standard` and is not gated by it.

| Tier | Model | Reasoning effort | Used for |
|---|---|---|---|
| fast | `haiku` | requested `low` — **not applied by the host for this model** | mechanical, fully specified work |
| standard | `sonnet` | session default | bounded implementation under established contracts |
| deep | `opus` | `high` | unresolved interacting constraints, or an observed reasoning failure |
| frontier | `opus` | `xhigh` | exceptional foundational uncertainty |

Planner dispatches use the deep and frontier tiers only. Tiers are abstract on purpose: the model names are a per-host
map, so the same policy can move to another coding host later.

`frontier` defaults to the strongest generally-allowed model, not to a restricted or premium one: a model like Fable
now runs only when the owner writes it into their own `models.frontier`, never inherited from the shipped default,
because 22 subagent runs went to Fable that way without the owner choosing it (issue #48). This one table
(`OWNED_AGENT_PROFILES` in `src/agents.ts`, joined with `DEFAULT_CONFIG.models`) is the single place a tier's model is
decided; each owned agent's frontmatter and `doctor`'s checks are both generated or checked from it, never hand-copied
in three places again. `npm run gen:agents` rewrites the six agents' `model:`/`effort:` frontmatter lines from that
table (add `--check` to fail without writing, for CI); `doctor` fails if an installed agent's frontmatter disagrees
with it, and separately fails if your own config's `models.<tier>` names a different model family than that agent's
installed frontmatter — the two are different code paths (a gated dispatch reads `models`, a direct or ungated one
reads frontmatter straight off the host) and can otherwise quietly disagree.

<details>
<summary><strong>Technical boundary: exactly where the gates run</strong></summary>

**Gate A** runs on a root `UserPromptSubmit` in `auto` with a `prompt_id`. Without a prompt identity there is no job and
no guard. Blank input, slash commands, child callers, a missing key or an invalid config make no request.

**The guard** is an allow-list and is active only while a job is orchestrated: the root may use Read, Grep, Glob, LS,
WebFetch, WebSearch, AskUserQuestion, TodoWrite, the Task tools, ListAgents and owned Agent calls. Everything else is
denied with a fixed reason. Named root tools are blocked and unknown tools are declined; this is a product execution
boundary, not a sandbox. A disabled or crashed hook removes it.

**Gate B** runs for a new eligible owned dispatch: foreground, no `model` pin, no `resume`/`agentId`/`name`/`team_name`/
`isolation`/`fork`, no concrete `CLAUDE_CODE_SUBAGENT_MODEL`, a valid `[JEV_TASK rev=<n> id=<id>]` marker naming a task
of the current plan revision whose dependencies are accepted, deliverables disjoint from running tasks, and the composed
contract within 64 KiB. The patch returns the complete original input with `subagent_type`, `model` and the appended
contract changed; permissions, role and every other field survive. Under `workerIsolation: "worktree"` a patched
*worker* dispatch also carries `isolation: "worktree"` — a planner dispatch never does, and the coordinator's own
incoming call still may not name `isolation` itself (see the ineligibility list above). Whether the host actually
gives that worker its own git worktree for a patched call is not yet observed on a live host.

**Gate C** (the Jev HTTP call that could tighten an already-accepted reply to `rework`/`replan`) is **removed from the
normal path**. Acceptance is the deterministic required-check completeness judgment described above; it is the only
thing that runs after a worker completes. Historical `result_intent`/`result_result`/advisory records written by Gate C
before this change remain readable as history.

**The plan-time scope gate is removed.** Earlier revisions asked Jev one `one_task | split | under_specified` question
per parsed plan before any worker ran; that call no longer happens.

Bounds per job: two planning attempts, two replans, two attempts per task, one parallel worker by default
(`maxParallelWorkers`, configurable — parallelism is not offered as a speed feature). Above one worker,
`workerIsolation: "worktree"` is required: a declared deliverable is the planner's claim about what a task writes,
not an enforced write boundary, and a worktree is the boundary rather than the claim. Job state lives in one
private file per session under `$XDG_STATE_HOME/jev-gate/jobs/` (0700/0600, atomic writes, superseded generations kept as
history). Any failure — missing key, timeout (one deadline covering headers and body), HTTP 401/422/429/529, invalid
response, oversized input — preserves the native call with a fixed stderr code. There are no retries.

</details>

## Try V5

Requirements: **Node.js 22+**, **official Claude Code signed in with a Claude.ai subscription** (the recorded checks used
2.1.275 and 2.1.276 on macOS), and a **TypeSafe API key** for `auto` mode. Start on a disposable project. Read the
[data disclosure](#your-login-your-data-your-choice) first.

```sh
git clone https://github.com/MongLong0214/jev-gate.git
cd jev-gate
npm ci
npm run build
PLUGIN_DIR="$PWD"

# Set TYPESAFE_API_KEY with your local secret workflow — never in chat, an issue or a committed file.
# The hook does not load a project's .env, and an interactive-only rc file is not enough — see below.
JEV_GATE_MODE=auto node dist/cli.js doctor      # diagnostics only, no inference

cd /path/to/your/project
JEV_GATE_MODE=auto \
CLAUDE_CODE_FORK_SUBAGENT=0 \
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 \
claude --model sonnet --plugin-dir "$PLUGIN_DIR"
```

Type normally. There is no `/jev` command.

**A foreground profile is required, not advisory.** A worker brief is eligible only when the Agent call is in the
foreground, and an interactive session defaults to fork mode where the host omits `run_in_background` entirely — so
without a foreground profile every brief would be refused as `not_foreground` and an admitted job would never reach a
worker, while its guard refused the main session's own edits. `CLAUDE_CODE_FORK_SUBAGENT=0` alone is enough for a call
that says `run_in_background: false`; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` also makes every call that says nothing
a foreground one, which is why the command above sets both. `CLAUDE_CODE_FORK_SUBAGENT=1` is refused. Both settings are
scoped to this command and are not written into your settings; the cost is real, because forcing the foreground means
subagents in that session no longer run in the background.

In a session without a foreground profile, or under a `CLAUDE_CODE_SUBAGENT_MODEL` override (which every owned Agent
call refuses), `auto` and `lean` stay native on every prompt as `host_unsupported` and send no Jev request (#48), since
an admission there could only be paid for. The forced bench arm (`JEV_GATE_EXPERIMENT_ADMISSION=orchestrated`) is
refused there too. `auto` says so once at SessionStart, and `doctor` fails on it, reading this shell and the managed,
project, project-local and user settings `env`; a variable only the launcher sets is not visible to it.

**Put the key where the launcher reads it, not only where you type.** The hook reads the environment of the `claude`
process, and an interactive-only rc file (`~/.zshrc`, `~/.bashrc`) is not read by a non-interactive shell, so a session
started by a launcher, an IDE, or a `tmux new-session` command string comes up without the key. For zsh the file always
read is `~/.zshenv`; confirm with `zsh -c 'echo ${TYPESAFE_API_KEY:+set}'`. This failure is silent by design — a missing
key is `key_missing` and `auto` preserves every eligible call — so `doctor` passing in your terminal is not evidence
that the hook has the key.

| Mode | What runs | Jev |
|---|---|---|
| `off` (default) | nothing: no admission, no guidance, no guard, no state or trace writes. Loaded agent definitions still exist — remove `--plugin-dir` and start a new session for the absent-plugin condition | 0 |
| `native` | the same roles, guard and contracts; the main session decides whether to start planning and picks tiers by choosing a worker profile | 0 |
| `auto` | Gate A on your request, Gate B on every planner and worker dispatch; acceptance is a deterministic check, not a Jev call | ≤ 1 request per gate event |

Optional config at `~/.config/jev-gate/config.json` (or `JEV_GATE_CONFIG`), `JEV_GATE_MODE` overrides the mode only, and
`JEV_GATE_MODE=off` returns before any file is read:

```json
{ "version": 5, "mode": "off", "jevModel": "jev-1.13.0", "requestDeadlineMs": 3000,
  "admissionConfidenceFloor": 0.8, "routeConfidenceFloor": 0.8, "resultConfidenceFloor": 0.8,
  "plannerDefaultTier": "deep", "maxParallelWorkers": 1, "guardAllowTools": [],
  "workerIsolation": "none",
  "delegationDepthFloor": null, "delegationDepthFraction": 0.6, "maxTasksPerPlan": 10,
  "admissionQuestionShape": "atomic", "routeQuestionShape": "atomic",
  "admittedShape": "auto", "delegationCoordinatorTurns": 11, "delegationWorkerTokensPerCall": 40000,
  "guardAllowMcp": true, "verifyWorkerChecks": true,
  "planInterpretation": false,
  "models": { "fast": "haiku", "standard": "sonnet", "deep": "opus", "frontier": "opus" } }
```

A V3 or V4 file is rejected with this sample and the plugin never rewrites yours — V5 sends more of your text to
TypeSafe, so an old `auto` setting is not carried over silently. Model mappings choose what a patch proposes; they grant
no account access. The three floors are uncalibrated policy values; `resultConfidenceFloor` is now a deprecated no-op
kept only for config compatibility, since the normal path no longer makes the Gate C call it used to gate.
`guardAllowTools` adds read-only tools your project needs during orchestration. `guardAllowMcp` (default `true`)
lets the coordinator call any MCP tool (`mcp__…`) itself while the guard is active: workers have no connector, so
without it a turn that needed Notion or Figma stalled. Set it to `false` and Gate A instead keeps a request that needs
a connector direct (`admission_external_tools`).

`workerIsolation` is `"none"` by default, and can be set to `"worktree"`: every planned worker dispatch the hook
patches then also carries `isolation: "worktree"` in the patched call (a planner, ad-hoc or single-executor dispatch
never does: those run one worker with no plan, and nothing would tell the coordinator to merge its branch back). It is
required once `maxParallelWorkers > 1` — a declared deliverable is the planner's claim about what a task writes, not
an enforced write boundary, and a worktree is the boundary rather than the claim — and it itself requires `"Bash"` in
`guardAllowTools`, because the root has to merge each worker's branch back while the guard is active. Whether the host
actually gives a patched call its own git worktree is not yet observed on a live host; this is a documented, tested
patch, not a measured behavior.

Isolation also needs the host's `worktree.baseRef` set to `"head"` in Claude Code settings
(`"worktree": {"baseRef": "head"}`). The host branches an isolated agent from that ref, and its default, `"fresh"`, is
`origin/<default-branch>` — a worker there would start without this branch's commits. The hook reads the setting
through the same scopes as the compaction window (managed, project-local, project, user); when it is anything but
`"head"`, including unset, the turn runs as `workerIsolation: "none"` with one worker at a time, and `doctor` warns.
Even with `"head"` a worker sees the last commit, not uncommitted changes, so the coordinator is told to commit what
a worker needs before dispatching it; under isolation its tool line names Bash as available for that and for merging.
Each isolated worker's prompt also asks it to commit its own changes on its worktree branch, without pushing, because
uncommitted edits in a worktree never reach the branch the coordinator merges. The coordinator is told to merge every
accepted worker's branch back, before dispatching a task that depends on it and before reporting the work done, so
a one-task plan or an independent last task is merged too. The hook reads project scopes only
from `CLAUDE_PROJECT_DIR`, which the host exports to hooks, since its own `cwd` moves with `cd`; without it the base
ref is unknown and the turn runs serially.

Every key after `guardAllowTools` is optional and defaults to the value shown. 0.4.0 changed three of those defaults
(`routeQuestionShape`, `admittedShape`, and the atomic gate's floor), so a V5 file that leaves them out now gets the new
behaviour; write the old value to keep the old one.

**Gate A prices the request (0.4.0).** The atomic gate asks how many tool calls the request would take (five bins) and
composes a price in code: delegate when `(turns − delegationCoordinatorTurns) × depth − turns ×
delegationWorkerTokensPerCall > 0`. Every root turn re-reads the whole session (1.00–1.05 × depth per turn over 631 real
prompts), so the saving is the root turns delegation removes; the coordinator still takes about 11 of its own (the
jev_single bench took 11–17). The bin-to-turns map `[0, 10, 10, 10, 60]` was set on the calibration half of a
pre-registered replay of 100 real prompts (`bench/results/v5-gate-a-cost-2026-09-28`). The same run is the honest
limit: Jev's read-off of the prompt text barely ranks the work it turns into (Spearman 0.05–0.08), because a short
prompt deep in a session carries work its text does not state; on the validation half the gate admitted 9 of 50, 6 of
them correctly, for a modelled saving of 66M of the 885M tokens those prompts actually cost. Admitting everything
would have saved more by the same model, which does not price what a worker loses by not seeing the conversation.

`admittedShape` is how an admitted turn runs. `auto` (the default since 0.4.0) runs `single` — one worker carrying the
request verbatim, no planner — unless Gate A read the request as separate outcomes or a whole project, in which case it
runs the planner hierarchy. On this repository's two jobs single passed 6/6 and hierarchy 4/6
(`DECISION-admitted-shape-2026-09-19.md`); the owner chose single-first on 2026-09-28. `hierarchy` and `single` pin
one shape.

`delegationDepthFloor` is how much context your session must already be carrying before Gate A is asked anything at
all. Below it the turn is direct and no request is sent. It exists because depth, not the request, is what decides
whether delegating is cheaper: the same job measured +182 % on a fresh session and -57 % on a loaded one. The number is
read from the session transcript the host passes to the hook, and a transcript that cannot be read counts as below the
floor. `0` turns the floor off; a transcript that cannot be read still keeps the turn direct.

With the atomic gate and `delegationDepthFloor: null`, the floor is the cost model's own: the shallowest depth at which
the largest answer could pay (48,980 tokens with the defaults), whatever the host window. The rest of this section
describes the composite gate, which has no price and keeps the window rule.

For the composite gate the default is `null`, not a fixed number (#48): a floor is only reachable if the host's own auto-compaction window is
above it, and that window varies by host and session (a 300,000-token window compacts a session before a fixed
300,000-token floor is ever reached — 1,014 admission decisions measured on this project's own dogfood session were 0
attempted). With `delegationDepthFloor: null`, the effective floor is derived from whatever window is known:
`min(300000, floor(delegationDepthFraction × window))` when the window is known, or the historical fixed 300,000 when
it is not. `delegationDepthFraction` (default `0.6`, accepted from `0.25` to `0.95`) is a policy choice, not a measured
crossing — say so if you change it. Setting `delegationDepthFloor` to an explicit non-negative integer keeps the old
absolute behavior exactly, including `0` to disable the floor.

**How the gate finds the host's compaction window** (`src/host-window.ts`, following Claude Code's own settings,
model-config and managed-settings pages). The first valid configured value wins: the
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment variable; then managed settings (`managed-settings.json` and
`managed-settings.d/*.json` in the system directory); then `.claude/settings.local.json` at the repository root (the
main checkout's root when you work in a linked worktree); then `.claude/settings.json` in the session's project
directory; then `$CLAUDE_CONFIG_DIR/settings.json` (or
`~/.claude/settings.json`). A file only counts if it parses as a JSON object with a positive `autoCompactWindow`;
anything unreadable, oversized (over 1 MiB) or invalid is skipped, never thrown. The value is clamped to the host's
100K–1M range and capped at the model's own context window, which is 200K under `CLAUDE_CODE_DISABLE_1M_CONTEXT`.
When nothing is configured, the host compacts at the model's context limit, so the gate takes the window from the
model the session transcript records: 1M for Opus 4.7 and later, Sonnet 5 and Fable on the Anthropic API, 200K for
earlier and smaller models.

The session's project directory starts at `CLAUDE_PROJECT_DIR`. `/cd` moves it, and the hook's `cwd` with it, but
leaves `CLAUDE_PROJECT_DIR` naming the start; a `cd` in Bash moves only the `cwd`. So neither names it once the
session has moved. The host keeps the session transcript in a folder named after that directory and moves it on
`/cd`, so the gate reads settings from whichever candidate (`CLAUDE_PROJECT_DIR`, the `cwd` and its parents) that
folder names. If it names none of them, the window is unknown rather than guessed. Without a transcript in that
layout, `CLAUDE_PROJECT_DIR` stands, and where the `cwd` differs from it every candidate must give the same window.
A launch with `--project-config-root` reads settings from that root, which a transcript folder does not name, so the
window there reads as unknown.

**Where this can still be wrong.** A launch's `--autocompact` or `--settings` flag, MDM policies and server-managed
settings are invisible to a hook. A native-1M model on Bedrock, Vertex or Foundry, Opus or Fable behind an LLM
gateway (`ANTHROPIC_BASE_URL`), a gateway model alias, or the first prompt after a `/model` switch (the host records
only the new model's display name until the next reply) leaves the window unknown. Behind a gateway, Sonnet 5 is
read as the 200K the host budgets it at unless `[1m]` was picked. In those sessions the floor stays at 300,000, which a 200K session never reaches: the gate then costs
nothing and saves nothing. That is deliberate — guessing low would admit shallow prompts on a 1M session, where forced
orchestration measured +182 %. It is not silent: after 50 auto-mode decisions with no Gate A attempt, the SessionStart
liveness notice tells you to run doctor. Run `node dist/cli.js doctor` to see the window, its source and the effective
floor. Doctor has no session model, so it reports the configured half and spells out the per-model defaults the hook
will apply. It **FAILs** when the floor is at or above a known window, **WARNs** when it is within 15% of one or when
no window is configured, and otherwise reports `info`.

`maxTasksPerPlan` rejects an accepted plan above that many tasks. It is a backstop against a runaway split rather than
a budget: every worker pays to be started, a 13-task plan measured +92.5 %, and plans that worked ran 2 to 7.

`admissionQuestionShape` and `routeQuestionShape` choose how each gate asks. `composite` is a single choice question.
`atomic` fans the same judgement out into read-off questions and composes them in this plugin's code, which is how the
vendor documents the model being used; neither atomic path consults its confidence floor, because the composition is
done here rather than by the model.

**Gate A ships `atomic`** (DECISION-defaults-2026-09-19.md): the composite question admitted 0 of 61 real prompts in
an offline replay even with depth supplied, so the gate never ran. The atomic path admits 41 of 65. That — a gate that
never fires against one that does — is the whole reason it ships; ~~at depth its admissions measured −59 % to −69 % on
the job turn~~ is **withdrawn (2026-09-20)**: the ladder built to establish that crossing reproduced none of its six
comparisons and the deepest rung reversed sign
(`bench/results/v5-depth-ladder-2026-09-19/RESULTS-WORK-RERUN-2026-09-20.md`). **Gate B ships `atomic` since 0.4.0**:
in real use the composite answer never cleared its 0.8 floor (0.78, 0.35), so every dispatch kept the tier the
coordinator called and the gate was paid for and ignored. The atomic shape composes fast, standard or deep in code with
no floor, so its answer is applied; it never picks frontier. The Router plugin leaves a jev-gate dispatch alone
(`gate_routed`), so Gate B's model and effort are the ones that run.

`planInterpretation` turns on one extra request, made after the planner replies and before its plan is adopted. It
compares each constraint the plan wrote down against your own request and the interfaces the plan proposes, and answers
per clause: `supported`, `contradicted`, `omitted` or `unknown`. **It rejects nothing.** The classification is written
to the trace beside the adopted plan, carrying `applied: false`, and the plan goes ahead exactly as it would have
without the call — including when a clause comes back `contradicted`, and including when the call fails.

It exists because a plan is the last place a discrepancy is still visible: the task contract, the checks and the
receipt are all derived from the plan, so a plan that quietly answers a different question than you asked is confirmed
by every stage after it. That was the observed hierarchy failure in
[`bench/results/v5-context-vs-decomposition-s1-2026-09-19/`](bench/results/v5-context-vs-decomposition-s1-2026-09-19/):
workers implemented an incorrect output shape, wrote tests that agreed with it, and produced accepted receipts.

It is off by default for two reasons. It costs a request per candidate plan and decides nothing, and nobody has shown
that this classifier is better than reading the plan yourself — a false objection on a correct plan would cost more
than the missed one it replaced. At most 12 clauses are asked about; a plan carrying more says how many went unasked
rather than dropping them silently.

Job state lives in `$XDG_STATE_HOME/jev-gate/jobs/` (`~/.local/state/jev-gate/jobs/` by default), one file per session,
containing your plan and task text. Delete the directory to remove it; a superseded job is kept as history inside its own
file until the session's file is removed.

Without a checkout, install `jev-gate@jev-gate` from the marketplace ([Install](#install)): it is the release's archive,
pinned by SHA-256. `npm run pack` writes the same archive locally, `dist-pack/jev-gate-<version>.zip` (compiled hook,
manifest, hooks, the six agent profiles and lean's executor, docs), byte for byte what `npm run release:check` rebuilds
from that commit; unzip it and load the extracted directory with `--plugin-dir /path/to/jev-gate-<version>`.

## What is verified, and what is not

Recorded observations are in [`bench/results/v5-host-2026-09-18/`](bench/results/v5-host-2026-09-18/) (Claude Code
2.1.275 and 2.1.276, macOS, Claude.ai subscription, nine headless sessions and one interactive session) and
[`bench/results/v4-host-2026-09-18/`](bench/results/v4-host-2026-09-18/) for the inherited task boundary.

| Observed | Evidence |
|---|---|
| A patch that changes `subagent_type` and `model` together spawns the target profile with its own tools and permissions | child `agent_type` and `resolvedModel`; haiku and fable children both ran and could still Edit and Bash |
| `prompt_id` is present on `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop` | key dumps per event |
| The planner returns a JSON plan that the hook parses; the job reaches `planned` and its ready ids reach the coordinator | plan trace, `rev 1` |
| The canonical task contract reaches the worker | workers reported check ids the coordinator never sent |
| The guard denies a root `Bash` during orchestration with the fixed reason; a child's own Bash is untouched | guard trace, child tool results |
| Direct admission runs with no planner, no guard and no owned call; `mode=off` writes no state, trace or guidance | separate sessions |
| One HTTP attempt per gate event; a real admission returned `direct` at p .99, confidence .98 | real-Jev smoke, 605 input tokens, 698 ms |
| `fable` applies the requested `xhigh` reasoning effort | `CLAUDE_EFFORT=xhigh` echoed by the child |
| A worker result judged invalid is reworked as `attempt=2` under the same plan | partial run cell |

| Not verified | Why it matters |
|---|---|
| **`haiku` ignores the requested `low` effort** | the child receives no effort value at all, so the fast tier's saving is the model price only |
| Parallel dispatch of independent tasks | the planners we observed produced serial chains; the default is now one worker at a time and parallelism is not offered as a speed feature, so multi-worker behavior stays untested |
| Real-Jev Gate B and Gate C in the host smoke | that session's admission returned `direct`, leaving no owned call; the partial run exercised them instead |
| A root `Edit` denial and the terminal stop in a live session | verified at hook level only |
| Any cost, runtime or quality benefit | see [Results](#results) |

Gate C's HTTP call has since been removed from the normal path (see [How V5 works](#how-v5-works-legacy-routing-modes)); the Gate C row
above describes the host-smoke session as recorded at the time, not the current design.

`doctor` reports configuration and environment issues (auth method, model overrides, launch profile, key presence, the
six role definitions and their effort fields). It also fails on two model-authority disagreements (#48): an installed
agent's frontmatter that drifts from `src/agents.ts`'s table (run `npm run gen:agents` to fix it), and your own
config's `models.<tier>` naming a different model family than that agent's installed frontmatter, which can otherwise
happen silently because a gated dispatch and a direct or ungated one read the model off two different places. It is
not proof that patching, effort or model access works on your host.
It also reports the host compaction window and the effective depth floor derived from it (FAIL/WARN as described
[above](#try-v5) when the floor cannot realistically be reached), and a liveness check: `<stateRoot>/jev-gate/liveness.json`
keeps the last 50 auto-mode admission decisions, and doctor WARNs — the same condition a new `SessionStart` hook warns
about directly in the transcript, via `systemMessage`, so you do not have to run doctor to notice — when all 50 never
attempted a Gate A call, which is exactly the #48 failure mode this floor change addresses. In `mode: "off"`, doctor
also WARNs that a hook process still starts per matched event even though the gate itself does nothing once running
(`src/entry.ts` short-circuits before importing the rest of the gate, but the host still spawns node); disable the
plugin entirely with `claude plugin disable jev-gate@<marketplace>` to remove that cost too.

`explain` answers the other question -- what the gate then did with a turn:

```bash
JEV_GATE_TRACE_DIR=~/.jev-gate/trace claude ...   # records are written only while this is set
node dist/cli.js explain ~/.jev-gate/trace
```

```
session ea4f96a2… (mode auto)
  gate A   direct  context unread (floor 300,000)  not asked  reason: depth_unknown
  stop     completed

  gate A   direct  context 388,131 tokens (floor 300,000)  jev http 200 685ms  reason: admission_answer_only
  stop     completed

  gate A   orchestrated  context 388,478 tokens (floor 300,000)  jev http 200 545ms
  denied   Bash  (1 so far this generation)
  dispatch planner  called deep → patch deep (opus)  jev http 200 585ms  → ran claude-opus-5[1m]
  plan     completed → ready rev 1, 5 task(s)  planner ran on claude-opus-5[1m]
  dispatch task t1 attempt 1  called standard → preserve standard (the model the coordinator called)  jev http 200 565ms  reason: route_low_confidence  → ran claude-sonnet-5
  result   task t1 attempt 1  worker-reported accept  (86s, 23 tool calls)
  dispatch task t2 attempt 1  called standard → patch standard (sonnet)  jev http 200 595ms  → ran claude-sonnet-5
  result   task t2 attempt 1  worker-reported accept  (68s, 10 tool calls)
  …
  stop     completed
```

That block is one recorded session from the `v5-replan-bound` run of 2026-09-19, abridged; those records predate the
`model` field, so the two model names in parentheses are the ones today's records would carry and the stored ones read
`(model not recorded)`. It is also a fair example of what the surface is for: the two turns that stayed native say why,
and Gate B preserved four of the five dispatches at low confidence rather than routing them.

A native call with no job state (#48: this is how 22 Fable runs went unrecorded before this change) still writes a
`post` or `failure` record carrying `requested_model` and `resolved_model`, so a run like that shows up in the raw
trace even without `explain`:

```bash
jq -r 'select(.phase=="post" and .job_state=="absent") | "\(.subagent_type): \(.requested_model) -> \(.resolved_model)"' ~/.jev-gate/trace/*.json
```

It reads the same records the benchmark reads, and states three things it cannot answer: a verdict is what the worker
reported about its own work, a model after `ran` is what the host reported resolving rather than a check that the
patch took, and a phase with no record means nothing was recorded, not that nothing happened.

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

<p align="center">
  <img
    src="./assets/readme/v4-flow.svg"
    width="860"
    alt="V4 flow. A Sonnet main session coordinates and integrates; a small task finishes directly with no Jev call; a delegated task goes to a worker or a read-only planner, where a PreToolUse Agent hook lets Jev evaluate that one task once and select a model. V5 keeps this task boundary and adds admission, mandatory planning and result judgment around it."
  >
</p>

V5 keeps this task boundary and adds the admission, planning and result gates around it.


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

### V5 evaluation

**Gate A, measured on 29 labelled prompts (live Jev, $0.001).** The admission question agreed with the intended label on
28 of 29. The five compound development requests were admitted at confidence 0.81–0.96 and every ambiguous or
contradictory prompt was preserved as `needs_context` or `abstain`. The two pilot jobs prepared for the whole-job
comparison were chosen `orchestrated` but at confidence **0.61 and 0.72**, below the uncalibrated 0.8 floor, so the
product policy would run them as one direct conversation. The floor was **not** lowered to change that; a diagnostic arm
with forced orchestration was added instead. Data: [`bench/results/gate-a-calibration-2026-09-18.json`](bench/results/gate-a-calibration-2026-09-18.json).

**One condition, stopped mid-execution — not a completed comparison.** The run planned four arms on `mini-sql`; it was
stopped for budget reasons partway through the first, `jev_forced_orchestration`, and the other three never started.
That arm forces orchestration and skips Gate A (`JEV_GATE_EXPERIMENT_ADMISSION=orchestrated`), so **no real Gate A
judgment ran in this cell** — admission is recorded as forced, not decided. So **there is no V5 cost, runtime or
quality result.** What the completed part of the cell shows is the rest of the mechanism working on a real job: a
planner producing a multi-task plan, five worker dispatches (`t1`, `t2`, `t2` attempt 2, `t3`, `t4`), of which four have
a published completed result (`t4`/analyzer's dispatch has none in this directory), one reply reworked, and three
advisory result judgments — plus one open question:

| Worker task | Jev route | Confidence | Upgrade basis | Applied |
|---|---|---:|---|---|
| errors module | standard | 0.96 | `no_specific_basis` | patch → standard |
| formatter | standard | 0.41 | `no_specific_basis` | preserve (below floor) |
| formatter, attempt 2 | standard | 0.38 | `no_specific_basis` | preserve (below floor) |
| parser | standard | 0.94 | `no_specific_basis` | patch → standard |
| analyzer | standard | 0.99 | `no_specific_basis` | patch → standard |

**Every task routed to the same tier.** No task was sent down to `fast` and none was sent up. In the shipped policy
`upgrade_basis` gates only `deep` and `frontier` — `fast` was already reachable, and `no_specific_basis` does not
explain why nothing went down to it. Why everything landed on `standard` has two explanations this one cell cannot
separate: the strong planner may already have resolved the design decisions that made `standard` appropriate, or the
router may have been missing information it needed. The one input gap this run actually confirms: the formatter task's
own previous `invalid` verdict was not carried into its `attempt=2` dispatch. That verdict itself was a report-format
failure (`check_id` didn't match the required pattern) — not a demonstrated implementation bug; whether the first
attempt's implementation was actually correct is unknown. The three Gate C verdicts recorded `accept`, but a
`worker_reported` accept is not independent proof the code works. Evidence:
[`bench/results/v5-run-1-partial-2026-09-18/`](bench/results/v5-run-1-partial-2026-09-18/).

Two defects the host verification caught before release: the benchmark runner inherited the launching session's
`CLAUDE_*` environment (so a measured session could silently run at the parent's reasoning effort), and the hook dropped
the host's effort field because it arrives as an object. Both are fixed; any earlier effort observation is invalid.

**Next.** [HANDOFF.md](HANDOFF.md) has the fix order — state correctness in the plan/dispatch machinery first, then the
bench's own observation and configuration accuracy, then carrying a task's own previous failure forward and keeping a
report-format fix separate from an implementation rework. Comparison arms run only after that, as a small experiment the
owner explicitly approves.

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

**In `auto` mode V5 sends two kinds of text to TypeSafe in the normal path**: your request at admission, and the
composed task contract with the relevant predecessor summaries at each planner or worker dispatch, each with fixed
evaluation criteria. (Earlier revisions also sent the worker's structured reply for a Gate C result judgment; that
HTTP call has been removed from the normal path — see [How V5 works](#how-v5-works-legacy-routing-modes).) That text can include source
excerpts, file names, and earlier user constraints — more than V4 sent, which is why a V4 configuration is rejected
rather than reused. The hook does not independently upload your repository, transcript or environment, but text
supplied by the caller can contain sensitive information. **Only enable `auto` for data you are authorized to send.**
There is no automatic secret-scrubbing or zero-retention guarantee. `native` and `off` send nothing.

Optional local traces (`JEV_GATE_TRACE_DIR`) hold per-phase JSON with prompt lengths and hashes, decisions, Jev usage and the child's reported model; they never contain the key or the prompt body, are written 0700/0600, and are not uploaded. Delete the directory to remove them.

## Build with us

**The most useful contribution is a real coding task—not another optimistic percentage.** Share a sanitized task, what a correct result should do, the host/model versions, and what actually happened. Easy tasks that were over-escalated and expensive tasks that did not benefit from a stronger model are both useful.

[Report a finding](https://github.com/MongLong0214/jev-gate/issues/new) · [Roadmap](https://github.com/MongLong0214/jev-gate/issues/21)

Implementation follows **[#21 PRD](https://github.com/MongLong0214/jev-gate/issues/21) → [#22 ADR](https://github.com/MongLong0214/jev-gate/issues/22) → [#23](https://github.com/MongLong0214/jev-gate/issues/23)–[#31](https://github.com/MongLong0214/jev-gate/issues/31)**. Issues #1–#18 preserve V3 and V4; their closure does not certify inherited defects as fixed. Contributor rules are in [AGENTS.md](AGENTS.md).

```sh
npm ci
npm run typecheck
npm test            # offline: fake HTTP, fake CLI, temp dirs; no key or login
npm run build
claude plugin validate . --strict
```

## Research and references

The [research review in ADR #22](https://github.com/MongLong0214/jev-gate/issues/22) connects routing, execution-state information, simple baselines, and coordination overhead to the design. Results from other models and benchmarks are not forecasts for this plugin.

[Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Native subagents](https://code.claude.com/docs/en/sub-agents) · [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) · [TypeSafe System One API](https://docs.typesafe.ai/api.md) · [Confidence](https://docs.typesafe.ai/confidence.md) · [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)

## License

A license has not yet been selected. No license file is present in this revision.

---

**Keep the hard thinking. Question the expensive default.**
