# Paired A/B bench (`node dist/bench/ab.js`)

Measures the installed plugin against itself switched off, on the same tasks, in the same repository. It is the only
kind of number the README may call a saving: a within-session "direct estimate" is not one (#130).

```
node dist/bench/ab.js run    --tasks bench/ab/tasks.example.json --out ~/.jev-gate/bench/2026-09-30 --model claude-fable-5-1 [--reps 3] [--only S,M] [--conds A,B,C,D] [--timeout-ms 3600000]
node dist/bench/ab.js report --out ~/.jev-gate/bench/2026-09-30 [--trace ~/.jev-gate/trace]
```

## Design

| | |
| --- | --- |
| Conditions | A everything off (baseline), B Gate only, C Compact only, D everything on (shipped defaults). Written as `--settings` plugin options; `JEV_GATE_MODE` is set to match because it overrides the option. |
| Two turns per cell | Turn 1 primes the context with the same prompt for every condition. Name the files to read explicitly: given only a directory, some model/effort pairs give up after one call (#134). Turn 2 (`--resume`) is the task and the only turn measured. A headless first prompt has no transcript, so Gate A reads `depth_unknown` and never asks Jev (#114); without priming, condition B and D would be A. |
| Order | Rotated one position per repetition (ABCD, BCDA, CDAB, DABC) so prompt-cache warming does not favour one condition. |
| Environment | The child inherits nothing named `CLAUDE_*` or `JEV_GATE_*` from the shell. |
| Model | `--model` is required and passed to both turns. A headless session otherwise follows `~/.claude/settings.json`, which another session's `/model` can change mid-sweep; two cells of the first sweep ran on a different model that way (#133). `report` reads the model each cell actually ran on from the transcript and excludes a cell whose model is not the pinned one (`model_mismatch`). |
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

- `_prime` must list the files to read one per line. "Read the 30 files under `<dir>`" is read reliably only by some
  model/effort pairs; others answer that Read cannot open a directory and stop after one call, which leaves that cell's
  context 40K smaller than its neighbours' and skews the comparison (#134). `prime_tools` per cell shows whether it worked.
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

`model`, `prime_effort` and `effort` are read from the transcript's assistant lines, per cell. The first Router effect
ever measured was condition D running the task at `medium` (priming at `low`) while A/B/C ran at `xhigh`: 55 s and $1.02
against 462 s and $5.60, with half the review text and a priming turn that read one file instead of thirty (#132). A
saving next to a lower effort is less work being done, not the same work costing less; the grid repeats the effort per
condition so that reading is not missed.

`gate_turns` is what Gate A estimated the prompt would take in root turns (`admission_result.estimate.turns`), beside the
measured `tools`. In the first sweep the estimate was about a tenth of the measured tool calls on every S and M cell, and
no S or M cell was ever delegated (#135); the column exists so that gap is a number per cell rather than an impression.

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
7. **A lower effort is not a saving until quality is judged equal.** The Router lowers effort; the cheaper cell then
   reads fewer files and writes less. Compare `effort` across conditions before reading `tok/A`, and judge the outputs
   side by side for the cells where it differs (#132).

Also budget for it: the second turn of a `--resume` session cost about $1.1 for a one-word reply in smoke runs (#119),
apparently from prompt-cache regeneration. It lands on every condition equally, so it does not bias the comparison,
but it inflates the absolute cost of a sweep.

## What this is not

Implementation done, plugin observed on an installed host, and a measured product effect are three different kinds of
done. A smaller packet, a Jev call that happened, or a passing test is not "tokens went down"; only this bench, read
with the caveats above, can say that.

The plan freezes task prompts and quality checks when the sweep starts. Resume accepts only identical inputs. Reports use that snapshot, not a subsequently edited tasks file. Missing transcripts, incomplete usage, failed priming and unobserved required checks are excluded with unknown token totals. Paired effects require all planned repetitions; partial successful pairs cannot establish an effect.
