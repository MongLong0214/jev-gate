# jev-gate

**Use frontier intelligence only when the task actually needs it.**

`jev-gate` is an experimental Claude Code plugin that puts TypeSafe's Jev in front of every supported natural-language turn.

You keep Claude Code on **Sonnet**. Jev interprets the request in one HTTP call, the plugin renders a compact, lossless execution brief, and the brief recommends whether Sonnet should handle the turn directly or delegate once to a native **Opus** or **Fable** subagent.

The goal: **reduce unnecessary Fable usage and total coding time without reducing task success.** That is a hypothesis this repository measures, not a result it claims.

> Status (2026-09-17, `jev-gate-claude-hook-v3`, v0.1.0): **plugin implemented, offline regression green, installed-host smoke verified on Claude Code 2.1.274 with a Claude.ai subscription login, and one four-case bench run recorded in [`bench/results/run-1-2026-09-17/`](bench/results/run-1-2026-09-17/).** On that task set the gate cut Fable volume, cost and wall time against an always-Fable session, and lost to plain Sonnet on both cost and time. One run on four development fixtures is a descriptive result, not a savings claim. Spec: [#1 PRD](https://github.com/MongLong0214/jev-gate/issues/1) → [#2 ADR](https://github.com/MongLong0214/jev-gate/issues/2) → [#3](https://github.com/MongLong0214/jev-gate/issues/3)–[#7](https://github.com/MongLong0214/jev-gate/issues/7).

## The idea

```text
user prompt (unchanged, stays in the conversation)
    ↓
Claude Code UserPromptSubmit hook   (hooks/hooks.json → dist/hook.js)
    ↓
Jev — one POST /v1/systemone with independent Choice questions
    ├─ task_kind   question | debug | change | review | design | other
    ├─ role_uN     goal | constraint | acceptance | background | mixed   (one per original block)
    └─ route       sonnet | opus | fable | context_required | uncertain  (auto mode only)
    ↓
code renders a short brief: exact quotes of your own text + fixed execution directives
    ↓
additionalContext for this turn only
    ├─ sonnet            → Sonnet handles it in the main session
    ├─ opus              → Sonnet delegates once to the native agent jev-gate:opus
    ├─ fable             → Sonnet delegates once to the native agent jev-gate:frontier
    ├─ context_required  → Sonnet resolves it with the existing conversation
    └─ any failure       → fixed neutral reminder; Claude continues natively
```

No dispatcher model, Claude proxy, MCP server, daemon, second login, or generated "rewritten prompt". Jev returns typed decisions with probabilities and confidence; the plugin turns them into text deterministically. Your message is never replaced or shortened: quotes are `JSON.stringify` of the exact original blocks, and if the brief would exceed 8 KiB the longest quotes become `uN role; current prompt UTF-16[start,end)` references instead of truncations.

## Install (local plugin)

Requirements: Node.js 22+, Claude Code (tested on 2.1.274) signed in with a Claude.ai subscription, a TypeSafe API key.

```sh
git clone https://github.com/MongLong0214/jev-gate.git
cd jev-gate
npm ci
npm run build

# The hook reads TYPESAFE_API_KEY from the environment of the shell that starts Claude Code.
# It never auto-loads a .env file. Never paste the value into chat, issues or Git.
export TYPESAFE_API_KEY=...
node dist/cli.js doctor

cd /path/to/your/project
claude --model sonnet --plugin-dir /absolute/path/to/jev-gate
```

Then type requests as usual. There is no `/jev` command. Each supported natural-language turn triggers exactly one Jev request; slash commands, empty prompts, subagent turns and `mode=off` trigger none.

`doctor` performs no inference. It checks Node, the built hook, plugin files, the installed `claude` version and `claude auth status` (login method only, no e-mail or IDs), conflicting environment variables, and the effective config. It exits 1 only when the plugin itself is broken.

### Foreground delegation in interactive sessions

Claude Code runs Agent calls in the background by default in interactive sessions (fork mode). For the delegate-once-in-foreground behavior the brief asks for, start with:

```sh
CLAUDE_CODE_FORK_SUBAGENT=0 claude --model sonnet --plugin-dir /absolute/path/to/jev-gate
```

`claude -p` sessions already run with fork mode off. `doctor` reports the current setting. With agent teams enabled, a *named* Agent call becomes a teammate; the plugin does not name its calls.

### Modes, config, disabling

| Setting | Where | Values |
| --- | --- | --- |
| Mode | `JEV_GATE_MODE` env (highest) or config `mode` | `auto` (default: annotations + routing), `enrich` (annotations only, no routing question, no delegation text), `off` (hook exits silently, zero Jev calls) |
| Config file | `JEV_GATE_CONFIG=/path.json` or `~/.config/jev-gate/config.json` | optional; defaults apply when absent |
| Trace | `JEV_GATE_TRACE_DIR` | off by default; when set, each turn writes one JSON with input, decision, Jev usage and output. Used by the bench only |

Default config (`version` must be 3; unknown keys and v1/v2 worker/frontier layouts are rejected with an explanation from `doctor`):

```json
{
  "version": 3,
  "mode": "auto",
  "jevModel": "jev-1.13.0",
  "requestDeadlineMs": 3000,
  "routeConfidenceFloor": 0.8,
  "uncertainTier": "fable",
  "opusModel": "opus",
  "frontierModel": "fable"
}
```

`requestDeadlineMs` must stay under the 5-second native hook timeout (max 4000). `routeConfidenceFloor` is an uncalibrated policy value, not an accuracy guarantee. Model fields are trusted identifiers only; nothing in a prompt or a Jev answer can change them.

To disable: stop passing `--plugin-dir`, or set `JEV_GATE_MODE=off`. The plugin never edits your global settings, hooks, agents or credentials.

## Routing policy (code, not the model)

- Route answers are validated strictly: exact option set, finite probabilities in [0,1] summing to 1, `choice` equal to the argmax, `confidence` in [0,1]. No coercion, no renormalization.
- `context_required` at the top or tied for the top → stay in the main conversation (`main_context`). This is not a difficulty rating.
- A unique top tier with `confidence ≥ routeConfidenceFloor` → that tier. `sonnet` runs in the main session; `opus`/`fable` render a one-time foreground delegation to `jev-gate:opus` / `jev-gate:frontier`.
- `uncertain`, ties, or low confidence → `uncertainTier` (default `fable`), labeled as a policy fallback in the brief.
- `task_kind` and roles degrade to `other` / `mixed` below a fixed 0.5 confidence or on ties; they never drop text.
- A missing or invalid route answer, HTTP 401/422/429/529, timeout, oversize input/response, missing key or invalid config → the fixed reminder `Jev Gate has no recommendation for this user turn. Continue natively; do not reuse a previous turn's routing hint.` Exit code is always 0; the hook never blocks, edits or deletes a prompt, and never retries.

The hook cannot change the current model or call the Agent tool itself. Delegation is Sonnet's own tool call, so the recommendation and what actually ran can differ; the bench records both. User instructions, plan mode, permissions, and model availability take precedence over any hint.

## What Jev receives

Only the current prompt split into lossless UTF-16 blocks (each non-blank line or code fence, merged to at most 24) plus fixed criteria text. Never the transcript, prior turns, repository files, environment, credentials, or benchmark answers. Requests over 128 KiB and prompts over 64 KiB are not sent; the turn proceeds natively.

## Bench: does it actually save anything?

`src/bench/run.ts` runs the same coding task through four arms with the official CLI (`claude -p … --output-format stream-json`) and grades the resulting source with trusted behavior checkers; `src/bench/report.ts` reads the saved files only.

| Arm | Root model | jev-gate | Question |
| --- | --- | --- | --- |
| `frontier_raw` | Fable | not loaded | What does always using the strongest model cost? |
| `frontier_enriched` | Fable | `enrich` | Does the brief alone change the work on the same root model? |
| `sonnet_native` | Sonnet | not loaded | Is plain Sonnet already enough? |
| `sonnet_gated` | Sonnet | `auto` | Does the product add value over native Sonnet? |

```sh
node dist/bench/run.js --cases bench/cases.json --out /outside/repo/run-1                      # plan only, 0 inference
node dist/bench/run.js --cases bench/cases.json --out /outside/repo/run-1 \
  --max-sessions 16 --timeout-ms 600000 --max-turns 40 --seed 42 --execute                      # 4 cases × 4 arms
node dist/bench/report.js --run /outside/repo/run-1
```

Before executing, the runner requires a `claude.ai`/`firstParty` login, refuses when `ANTHROPIC_API_KEY`, gateway/cloud variables or `CLAUDE_CODE_SUBAGENT_MODEL` are active, requires `TYPESAFE_API_KEY`, and fails if `--max-sessions` is below the planned cell count. Every arm gets the identical prompt on stdin, a fresh copy of the fixture, `--setting-sources project,local` (your user-scope plugins and hooks stay out of all arms equally), `--no-session-persistence`, and the same permission mode and tool allowlist. Plugin arms add `--plugin-dir` plus `JEV_GATE_MODE`/`JEV_GATE_TRACE_DIR`. Baseline arms confirm the absence of `jev-gate` from the session's `system/init` plugin list.

Reported per arm: planned/started/pass/fail/unknown, whole-tree per-model tokens from the final `modelUsage` (parent Sonnet, every child, and any helper model), Fable tokens, Claude's API-equivalent cost estimate, Jev list-price estimate, elapsed wall time, gate latency, fallbacks, and recommendation-versus-actual delegation. Deltas use only cases where all four arms completed with full accounting:

```text
Fable volume change   = 1 - Σ Fable_gated / Σ Fable_frontier_raw
total est. cost change = 1 - Σ (Claude_gated + Jev_gated) / Σ Claude_frontier_raw
elapsed change         = 1 - mean(elapsed_gated) / mean(elapsed_frontier_raw)
```

Subscription usage is not API billing, so token counts and estimates are never presented as charges or quota. A Fable-free failure is not a saving. A gated run slower than plain Sonnet is a valid negative result. See [bench/README.md](bench/README.md) for the fixtures.

### What run-1 actually measured

4 cases × 4 arms, seed 42, concurrency 1, 2026-09-17, Claude Code 2.1.274, Claude.ai team subscription. Full tables in [`bench/results/run-1-2026-09-17/report.md`](bench/results/run-1-2026-09-17/report.md).

| arm | pass / 4 | Fable tokens | est. cost | mean wall time | recommendation followed |
| --- | --- | --- | --- | --- | --- |
| `frontier_raw` | 3 | 657,473 | $2.394 | 50.9 s | – |
| `frontier_enriched` | 3 | 770,218 | $2.495 | 51.9 s | – |
| `sonnet_native` | 4 | 0 | $0.578 | 22.2 s | – |
| `sonnet_gated` | 4 | 259,205 | $1.424 | 41.5 s | 4 / 4 |

Against `frontier_raw` the gate cut Fable volume 60.6%, estimated cost 40.5% and wall time 18.5%. Against `sonnet_native` it cost 2.5× more and took 1.9× longer for the same four passes, because one case landed just under the confidence floor and escalated to Fable. On this task set most of the benefit comes from starting on Sonnet at all, and the gate's own value rests on whether it rescues tasks Sonnet would fail — which these four fixtures did not demonstrate. Adding the brief to an always-Fable session (`frontier_enriched`) increased Fable tokens 17% and cost 4%, a negative result.

The `search-race` verdict for `sonnet_native` changed from fail to pass when the checker was corrected after the run: it had judged "add a test that reproduces the late response" by counting files in `test/`, and that candidate added the regression test inside the existing file. The checker now runs the candidate's own tests against the unfixed source and requires them to fail. Both scorings are kept, in `report.md` and `report.checker-v1.md`, and `node dist/bench/run.js --regrade` re-scores saved snapshots with no model calls.

## Development

```sh
npm ci
npm run typecheck   # src + tests
npm test            # 65 offline tests: lossless blocks, config, Jev contract, Brief, hook process, fixtures vs reference, fake-CLI bench
npm run build
claude plugin validate . --strict
```

Tests use fake HTTP and a fake `claude` binary; they never call TypeSafe or Claude and never require a key or login. CI runs the same steps on Node 22. Passing fakes prove the code paths, not model behavior; installed-host checks are separate and documented per release.

## Scope

Not included by design: automatic tier escalation or retries, multi-agent review loops, a worker model provider, Anthropic API proxying or custom OAuth, repository indexing, transcript summarization, UI, database, MCP server, daemon, automatic commit/push/deploy, marketplace publishing without `dist`.

## Official references

Contracts were checked against the live documentation on 2026-09-17:

- [TypeSafe HTTP API](https://docs.typesafe.ai/api.md) · [Choice](https://docs.typesafe.ai/primitives/choice.md) · [Confidence](https://docs.typesafe.ai/confidence.md) · [Models](https://docs.typesafe.ai/models.md)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) · [subagents](https://code.claude.com/docs/en/sub-agents) · [plugins reference](https://code.claude.com/docs/en/plugins-reference) · [headless](https://code.claude.com/docs/en/headless) · [cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) · [authentication](https://code.claude.com/docs/en/authentication)
- [frontier-simplify](https://github.com/MongLong0214/frontier-simplify/blob/96b07ad17e90fd4e69e1a7748641d7f30c06fcf0/skills/frontier-simplify/SKILL.md)

## License

TBD until the repository license is added.
