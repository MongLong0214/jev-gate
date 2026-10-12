# Long-session pilot — native Claude Code vs Jev Gate v0.8.15 (2026-10-12)

**Pilot, one pair per task.** On two real feature tasks run as 17-turn sessions, the Jev Gate session cost
**0.50× and 0.44×** of the native session, used **0.35× and 0.38×** of the tokens, and reached the **same total
quality score (21 / 23)** under blind grading. One pair per task cannot separate this from session-to-session
variance; treat it as a direction to confirm, not a guaranteed saving.

| task | arm | cost (host) | Jev requests | total tokens | max context | agent time | quality |
|---|---|---:|---:|---:|---:|---:|---:|
| Form feature with BE contract | native | $15.58 | — | 37.3 M | 442 K | 49.8 min | 10 / 12 |
| | **jev_gate** | **$7.76** | 66 ($0.011) | **13.2 M** | **206 K** | **24.5 min** | **10.5 / 12** |
| Async UI interaction | native | $27.24 | — | 74.4 M | 673 K | 73.9 min | 11 / 11 |
| | **jev_gate** | **$11.89** | 40 ($0.006) | **28.1 M** | **353 K** | **40.9 min** | **10.5 / 11** |
| **both** | native → jev_gate | **$42.81 → $19.65 (0.46×)** | | **111.7 M → 41.3 M (0.37×)** | | **124 → 65 min** | **21 → 21** |

Jev Gate cost includes its own Jev requests at the frozen list price ($0.042 / M input tokens,
`src/bench/usage.ts`). Pricing those requests at Claude Opus rates instead would add at most $1.33 and $0.71, which
would move the ratios to 0.58× and 0.46×. Per-cell rows: [`cells.tsv`](cells.tsv).

## Where the saving came from

Both native sessions grew one main context to 442 K and 673 K tokens and re-read it from cache on every request;
cache reads are 98 % of their tokens. The Jev Gate sessions moved exploration, test and review work to Sonnet and
Haiku subagents (7 and 4 subagents; 4.1 M and 2.5 M tokens off Opus), which kept the main context at roughly half
the size. Cache reads fell to 0.33× and 0.37×, output to 0.52× and 0.46×, thinking to 0.18× and 0.31×. Cache writes
rose (2.4× and 1.7×) because each subagent starts its own cache; that is already inside the cost above.

## Setup

- **Code base:** a private production TypeScript frontend (Next.js 16, React 19, Jest, ESLint). Each task re-implements
  a merged pull request from its parent commit in a fresh git worktree. The merged PR is the reference answer.
- **Tasks:** (1) a download-request option with a strict backend contract (omit keys when a toggle is on, validation,
  history-detail rows, preserved values); (2) a click-to-add-row interaction that waits for real asynchronous
  recalculation state, then restores focus and replays the click, with abort and input-type rules.
- **Session:** one task prompt, then 16 fixed follow-ups in every cell — type-check, related tests, lint, explain the
  flow, apply project rules, add unit tests, reuse audit, accessibility pass, a summary after a 400 s idle gap
  (cache-expiry pressure), full self-review, rerun all checks, PR body draft, final open items.
- **Host:** Claude Code 2.1.294, `claude-opus-5-5`, effort `xhigh`, the owner's token-relevant settings (1 h prompt
  caching, thinking and output limits), `--strict-mcp-config`, a per-cell nonce in the system prompt so cells share
  no prompt cache. Both arms identical except the plugin.
- **Arms:** `native` = no plugin. `jev_gate` = the released v0.8.15 plugin (dist identical to the marketplace cache),
  default settings, `auto` mode.
- **Cost:** the host's cumulative `total_cost_usd`. Transcript totals per model (main and every subagent) were checked
  against the host's per-model usage: output and cache-read counts match exactly in all four cells (one cell differs
  by 225 Sonnet output tokens).

## Quality

A rubric (12 items for task 1, 11 for task 2, plus deductions) was written from the reference PRs and frozen
before any cell diff was opened (sha256 `2c33f36c4c471e5cf9b6f2d58976907c97b1c2fb55506ead7621330af76ac89b`).
Diffs were relabelled X/Y at random and graded by two independent graders that did not know the arm. They
disagreed on one item; it was settled from the code in favour of the stricter score. The mapping was opened only
after grading.

- Objective checks on a clean worktree with only each final diff applied: **0 new type errors, 0 lint errors,
  all of the cell's own tests pass** (69 / 55 / 111 / 89) in every cell.
- Task 1: jev_gate 10.5, native 10. The native cell rendered the new yes/no row as plain text instead of the
  existing boolean badge. Both lost one point for an unrequested UI change (a new hint text; a focus-ring change on
  a shared toggle).
- Task 2: native 11, jev_gate 10.5. In the jev_gate cell, pressing the gap between radio/checkbox options selects
  the first option on the new row — a real defect the native cell does not have.

## Deviations and limits

- **n = 1 per task.** Earlier benches in this repo saw same-arm cost spreads of tens of percent; the full run
  (≥ 3 pairs per task) is pending.
- A planned "hidden reference tests" stage was dropped during the run, before any result was read: the reference
  tests import the reference PR's own file names, so a correct implementation with other names fails them. Their
  output is not used.
- An analyzer line that summed Router *result* events into "Jev usage" was corrected; only Router assessment
  requests (`root`, `child_route`) are Jev requests.
- One native cell ran a read-only `gh pr view` on an unrelated pull request while drafting a PR body. Cells now run
  with `gh` unauthenticated and pushes blocked. No cell pushed or opened a pull request.
- Raw transcripts, diffs and grader reports stay outside the repository (private code base).
