# Pre-registration — the second job, written before the run (2026-09-19)

Every cost figure in this repository comes from one job, `wide-validators`. The largest open gap is whether the
saving survives work of a different shape. This run asks that, and nothing else.

## The one variable

| job | shape | reference |
|---|---|---|
| `wide-validators` (measured: job turn −64.2 %, session −31.8 %, wall +3.8 %) | wide and shallow — 12 independent modules, a one-line fix each | 260 lines |
| **`orbit-core` (this run)** | **wide and deep** — 6 independent modules plus one that composes them, each a real implementation | 319 lines |
| `mini-sql` (not in this run) | narrow and serial — lexer→parser→analyzer→executor, with ~6,000 characters of shared grammar every worker needs | 740 lines |

`orbit-core` changes **task depth** while holding independence roughly constant. `mini-sql` would change independence,
serial dependency and shared-spec weight at the same time, so a lost saving there could not be attributed. It is the
third job, to be run only if this one holds.

## The cells

**Case:** `orbit-core-primed-30` (`bench/cases-depth.json`). **Arms:** `sonnet_native`, `jev_hierarchy`.
**Repetitions:** 2 → four cells. **Config:** the shipped defaults, read from `~/.config/jev-gate/config.json` —
`mode: auto`, `admissionQuestionShape: atomic`, `routeQuestionShape: composite`, `delegationDepthFloor: 300000`,
`maxParallelWorkers: 1`, `maxTasksPerPlan: 10`. Nothing is forced.

```sh
node dist/bench/run.js --cases bench/cases-depth.json --only orbit-core-primed-30 \
  --out ~/jev-gate-runs/v5-job2-orbit --execute --max-sessions 4 \
  --arms sonnet_native,jev_hierarchy --repetitions 2 \
  --plugin-dir "$PWD" --timeout-ms 2400000 --max-turns 120 --seed 20260919
```

**`jev_forced_orchestration` is dropped, and the reason is recorded here rather than after the fact.** It is a
diagnostic that separates "the gate chose well" from "the planner split smaller", a question this design cannot answer
either way, and including it would raise the cost by half while adding nothing to the question being asked.

**No baseline is reused.** Unlike `v5-gate-a-live-2026-09-19`, no native cell exists for this case, so both native
cells are run here.

**Turn and time budgets are raised, identically for both arms**, because this job is larger than any run before it:
120 turns (30 of them spent priming) and 40 minutes per cell. A cell that hits either limit is invalid, not a slow
result.

## Fixed before the run

1. A cell is **invalid** if `context_at_job_prompt` is below 250,000, as in every primed run before this one. Achieved
   depth is read from the cell, never from the case name.
2. A cell is **invalid** if it is truncated by `--max-turns` or `--timeout-ms`.
3. **Quality gates the cost comparison.** A cost claim requires all four cells to pass the checker. If the arms differ
   in pass count, that difference is the result and **no cost comparison is reported** — equal pass counts are not
   quality equivalence, and unequal ones are not a cost finding.
4. **The primary outcome is the direction and magnitude of the job-turn delta against `sonnet_native`**, reported
   beside the `wide-validators` figure. The conclusion is one of:
   - **holds** — the saving is in the same direction and of the same order (job turn ≥ 15 % below native);
   - **does not hold** — the saving is absent or reversed (job turn at or above native);
   - **undecidable** — the delta falls under 15 %, or the native arm's own two cells differ by more than the delta.
5. **Nothing under 15 % is quoted from this bench.** Plan size is a free variable (4, 2, 2, 3, 2, 3 observed for one
   job) and sets the size of the saving, so resolution is ~47 % when plan size is free. A precise percentage is not an
   outcome of this run; the category in rule 4 is.
6. **Worker count and plan size are recorded per cell as covariates.** They are not controlled and no claim is made
   that they are. Worker counts seen on `wide-validators` so far: 13, 4, 4, 3, 3.
7. The gate's decision on each of the three prompts is recorded whatever it is. The two priming prompts are expected
   to be refused; a refusal there is not a failure of this run. If the **job** prompt is refused, its recorded reason
   is the result and no cost claim is made.
8. Failures, cancellations, timeouts and unknown cells are published with their cause. A negative result is the
   deliverable, not a reason to re-run.
9. **No floor, checker, criterion or default is adjusted after seeing these results.** If something here needs
   changing, it is a new pre-registration and a new measurement.
