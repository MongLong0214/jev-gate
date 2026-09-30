# Paired A/B bench (`node dist/bench/ab.js`)

Measures the installed plugin against itself switched off, on the same tasks, in the same repository. It is the only
kind of number the README may call a saving: a within-session "direct estimate" is not one (#130).

```
node dist/bench/ab.js run    --tasks bench/ab/tasks.example.json --out ~/.jev-gate/bench/2026-09-30 [--reps 3] [--only S,M] [--conds A,B,C,D] [--timeout-ms 3600000]
node dist/bench/ab.js report --out ~/.jev-gate/bench/2026-09-30 [--trace ~/.jev-gate/trace]
```

## Design

| | |
| --- | --- |
| Conditions | A everything off (baseline), B Gate only, C Compact only, D everything on (shipped defaults). Written as `--settings` plugin options; `JEV_GATE_MODE` is set to match because it overrides the option. |
| Two turns per cell | Turn 1 primes the context with the same prompt for every condition. Turn 2 (`--resume`) is the task and the only turn measured. A headless first prompt has no transcript, so Gate A reads `depth_unknown` and never asks Jev (#114); without priming, condition B and D would be A. |
| Order | Rotated one position per repetition (ABCD, BCDA, CDAB, DABC) so prompt-cache warming does not favour one condition. |
| Environment | The child inherits nothing named `CLAUDE_*` or `JEV_GATE_*` from the shell. |
| Editing tasks | `base` checks that commit out in a fresh git worktree under `--out/wt/`, with the main checkout's `node_modules` linked. Worktrees are removed by `git worktree remove --force` (#126). |
| Timeout | Every `claude -p` and every check command gets `--timeout-ms` (default 1 h) and is killed past it; the cell is recorded `timed_out` and excluded (#121). |
| Resume | A cell whose result file exists is skipped, so an interrupted sweep continues where it stopped. Progress is read from the files (`started_at`, `wall_s`, and `report` lists cells with a prime but no result), never from a remembered start time (#127). |
| Output | Sequential on purpose: the example tasks share a browser and a local server. Everything lands under `--out`; use a permanent directory, not a session scratch path (#125). |

## Tasks file

```json
{
  "_prime": "Read all 30 .ts/.tsx files under app/(routes)/... with the Read tool and print one line each. Use no other tool.",
  "_repo": "/path/to/repo",
  "S": { "prompt": "Review PR #3980; report only." },
  "M": { "prompt": "Apply the valid review comments on PR #4184 in this worktree. No commit, push or PR.", "base": "23973aa20",
         "check": "git diff --quiet && exit 1; pnpm exec jest 'data-transfer./downloads/' || pnpm exec jest 'data-transfer./downloads/'" },
  "L": { "prompt": "Run the e2e for feature X in the local browser to completion.", "resultPattern": "SUCCESS|zip" }
}
```

- `check` runs in `/bin/sh` inside the task's cwd after the task; exit 0 passes. Jest path patterns are **regular
  expressions**: `(routes)` and `[projectPk]` are metacharacters and match nothing as written; use a fragment such as
  `'data-transfer./downloads/'` or escape them (#122).
- `resultPattern` is a case-insensitive regex the final result text must match. It is a weak gate: a run that passed it
  is not proven to have the same quality as another that did.

## Reading the report

The first table is one row per cell. The second is medians per task x condition over `ok` cells only, the ratio to A,
and a **paired sign** column: `3/3 below A → effect` means the condition used fewer task-turn tokens than A in every
repetition where both were ok. Anything less is reported as `k/n below A` and is not an effect, whatever the medians
say. Cache creation and cache read are separate columns because they price differently and warm differently.

`prime_tools` is how many tool calls the priming turn made, so "read 30 files" is a checked fact per cell (#123).

## Interpretation caveats (read before quoting a number) — #129

1. **Cache warming distorts cost between conditions.** The same request cost $1.24 as 61,924 cache-creation tokens when
   it ran first and $0.43 as 42,636 cache-read tokens when it ran next, with the plugin doing nothing in either. Rotation
   spreads this; it does not remove it. Compare `cache_create` and `cache_read` separately.
2. **Condition A still has the host's own auto-compaction** (threshold 0.7 on a 300K window). C and D measure
   "jev compact vs host compact", not "compact vs none".
3. **The two-turn design makes the task turn itself heavier**: the ~20K priming context is re-read from cache on every
   request. This is closer to a real session than a single turn, but single-turn and two-turn results must never be
   mixed in one table.
4. **Run-to-run variance is large.** The same review prompt took 24 Bash calls in one cell and 39 plus an MCP server in
   another with no plugin difference. Three repetitions may not separate that from a plugin effect, hence the paired
   sign rule.
5. **The quality gates are weak.** `check` and `resultPattern` exclude runs that failed outright, because a failed run
   spends fewer tokens and would look like a saving. They do not show that two passing runs did equal work.
6. **Three repetitions give a direction, not a size.** There is no statistical test here. Report the paired sign and
   the medians, and say so.

Also budget for it: the second turn of a `--resume` session cost about $1.1 for a one-word reply in smoke runs (#119),
apparently from prompt-cache regeneration. It lands on every condition equally, so it does not bias the comparison,
but it inflates the absolute cost of a sweep.

## What this is not

Implementation done, plugin observed on an installed host, and a measured product effect are three different kinds of
done. A smaller packet, a Jev call that happened, or a passing test is not "tokens went down"; only this bench, read
with the caveats above, can say that.
