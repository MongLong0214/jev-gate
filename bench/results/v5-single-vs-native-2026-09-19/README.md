# Result — the context move pays on its own (2026-09-19)

Pre-registration: `PREREGISTRATION.md` in this directory, committed before the run (`ed2a419`, `6afe225`,
`ec0be22`). Plugin build: `ed2a419`. 8 cells, 2 jobs, 2 arms, 2 repetitions, one frozen config
(`ac58c9469753…`). Owner approved these cells directly before any of them ran.

## Headline

**`jev_single` is cheaper than `sonnet_native` on both jobs, and the kill criterion is not met.** Moving an admitted
turn whole into one fresh worker — no planner, no plan, no contract, no replan path — costs less than answering the
same request in the loaded session, on both jobs, by more than this bench's 15 % quoting floor.

| job | cells | quality | `sonnet_native` job turn | `jev_single` job turn | difference |
|---|---|---|---|---|---|
| `wide-validators-primed-30` | 4 | **4/4 pass** | $2.5621, $3.5825 (mean $3.0723) | $0.8587, $0.9241 (mean $0.8914) | **−71.0 %** |
| `orbit-core-primed-30` | 4 | **4/4 pass** | $3.0281, $2.3602 (mean $2.6941) | $1.9396, $2.3494 (mean $2.1445) | **−20.4 %** |

All 8 cells are valid: depth at the job prompt 387,439–388,500 (rule 1 floor is 250,000), no truncation, no
environment error, `exit=0` everywhere, usage complete. Rule 3 is satisfied on both jobs — all four cells of each
job passed its checker — so both cost comparisons are reportable. Nothing is pooled across jobs.

## The caveat that belongs next to the orbit number

On `wide`, the arms do not touch: the most expensive `jev_single` cell ($0.9241) is a third of the cheapest
`sonnet_native` cell ($2.5621), and the gap is far larger than either arm's own spread. That result is as clean as
this bench produces.

**On `orbit`, it is not.** The arms are adjacent rather than separated:

- `jev_single` orbit cells span $1.9396–$2.3494 — a 21 % spread inside one arm.
- `sonnet_native` orbit cells span $2.3602–$3.0281 — a 28 % spread inside one arm.
- The worst `jev_single` cell and the best `sonnet_native` cell differ by **$0.011, about 0.5 %**.

So the 20.4 % difference on orbit is smaller than the cell-to-cell variation of either arm, at two cells per arm.
It clears the pre-registered floor and it is reported as the pre-registration says to report it — and it is **one
job's mean over two cells, not a separation this run can resolve.** The wide result carries the headline; the orbit
result is consistent with it and is not independent evidence of the same strength.

## What the kill criterion said, and what happened

Written before the numbers existed: *"If `jev_single` does not beat `sonnet_native` by more than 15 % on both jobs,
the README says so in its first line"* — the product's measured value would not survive removing the hierarchy, and
a saving that needs a new session is not a saving this plugin produces.

That did not happen. On the pre-registered metric the product clears it on both jobs. **The narrow claim this run
supports is exactly this: for an admitted turn in a session already ~390K deep, dispatching the request whole into
one fresh worker costs less than answering it in place, at the same checker result.** Every other claim about this
product is out of this run's scope.

| pre-registered falsification | outcome |
|---|---|
| the context move alone pays | **not falsified** (−71.0 % wide, −20.4 % orbit) |
| the product has a reason to exist beyond a new session | **not falsified** on this metric |
| the single shape is quality-neutral | **not falsified** — 4/4 `jev_single` cells pass, as do 4/4 native |
| the shape is well-behaved | **not falsified** — Gate A admitted 4/4 on its own, exactly one worker per cell |

## It is not free: wall-clock

| job | `sonnet_native` | `jev_single` |
|---|---|---|
| `wide` | 137.9 s, 190.0 s (mean 164.0) | 271.6 s, 212.6 s (mean 242.1) |
| `orbit` | 448.0 s, 355.8 s (mean 401.9) | 538.8 s, 588.7 s (mean 563.8) |

`jev_single` is **slower on every cell of both jobs** — about 40–48 % on the means. The dispatch pays for a fresh
worker that has to read what the loaded session already had. That is the trade the saving is made of, and it is not
a rounding error.

## Mechanism counts (rule 6)

| job | arm | rep | root turns | Read | distinct paths | Bash | test runs | Write | Edit | workers |
|---|---|---|---|---|---|---|---|---|---|---|
| wide | `sonnet_native` | 1 / 2 | 42 / 43 | 14 / 13 | 14 / 13 | 33 / 35 | 1 / 1 | 11 / 11 | 13 / 13 | 0 |
| wide | `jev_single` | 1 / 2 | 11 / 11 | 22 / 18 | 21 / 14 | 33 / 37 | 1 / 1 | 11 / 11 | 13 / 13 | 1 |
| orbit | `sonnet_native` | 1 / 2 | 27 / 22 | 0 / 6 | 0 / 6 | 43 / 36 | 4 / 3 | 14 / 8 | 0 / 1 | 0 |
| orbit | `jev_single` | 1 / 2 | 13 / 17 | 16 / 19 | 12 / 14 | 37 / 36 | 5 / 2 | 14 / 14 | 1 / 1 | 1 |

The saving is not fewer tool calls. Bash counts are within a few of each other everywhere, and the edits and writes
that constitute the work are the same size in both arms on `wide` (11 writes, 13 edits in all four cells). What
collapses is **root turns**: 42–43 → 11 on wide, 27/22 → 13/17 on orbit. The expensive thing in a 390K session is a
root turn at that depth, and this shape has the fresh worker take them instead.

Gate A admitted the job on its own in all four plugin cells (`orchestrated:4`, no forcing). Gate B patched all four
dispatches to `standard` (route confidence 0.97–0.99). Jev cost for the whole run: **$0.0007**.

## The instrumentation repair is confirmed end to end

`r-singlereceipt` shipped in `ed2a419` and this run is its first end-to-end observation: `receipts accept:4`,
`outcomes completed:4`, **`orphan records 0`**, each post record carrying `task_id: single`, `attempt: 1`,
`verdict: accept`. In stage 1 the same arm recorded `accept:0`, `incomplete:2`, `orphans 2`.

**What an accept means here has not changed, and is still weaker than the hierarchy's.** There is no contract, so
no code checked the reply: the verdict is the worker's own report of `status: done` with no blockers, recorded and
rendered as reported rather than verified. The checker — which is not the plugin — is what says the work was right,
and it says so for all 8 cells.

## What this does not settle

- **Nothing about `jev_hierarchy`.** It was not in this run, by design. This says the context move pays; it does not
  say splitting adds or subtracts anything on top, and the stage 1 finding about plans freezing what a request
  leaves open is untouched by it.
- **No default change** (rule 10). `admittedShape` stays `hierarchy`. This is a bench result, not a release, and
  the shape that just won two jobs is still the one that is off by default.
- **Depth.** Both jobs prime to ~390K. Nothing here says what happens at 50K, and the earlier cross-over
  observation (180K–281K) was made on a different shape.
- **n = 2 per arm per job.** The orbit margin in particular sits inside the arms' own spread.
