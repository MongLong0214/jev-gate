# The two savings compose — 2026-09-19

`PREREGISTRATION.md` was committed before this run. It predicted that if the tier compounds with delegation the cell
would pass the checker and come in under $2.69, and said in advance that a checker failure would be a result about the
gate's selectivity rather than about the tier.

It passed, and it came in well under.

## Result

Same job, same fixture, same twelve-module checker, **zero failed checks in every arm**:

| arm | workers | cost | turns | wall | main peak |
|---|---|---|---|---|---|
| `sonnet_native` | — | **$6.2851** | 74 | 324.6 s | 406,218 |
| `jev_forced_orchestration` | sonnet | $2.6922 | 8 | 386.0 s | 127,216 |
| `jev_forced_orchestration` | **haiku** | **$1.1465** | 9 | 285.1 s | 68,070 |

**$6.2851 → $1.1465 is −81.8 %**, with the output decided by the checker rather than by inspection.

The two layers multiply rather than overlap:

```
delegation      6.2851 → 2.6922    × 0.43
tier            2.6922 → 1.1465    × 0.43
                                   × 0.18 together
```

That they compose is the point. Delegation removes the context each turn re-reads; the tier lowers the price of the
turns that remain. They act on different factors of the same product, so neither absorbs the other.

## Four things this does not say

**The planner is now the largest fixed item.** `claude-opus-5` costs $0.3358 here — nearly unchanged from the $0.3608
and $0.4192 measured before — but as the total fell it went from about 12 % of the bill to **29 %**. The next lever is
there, not in the workers.

**Shallow jobs still lose, and by more.** The fresh cell came in at **$0.9239** against `sonnet_native`'s $0.3148 — three
times the cost, with the same haiku workers. The cheap tier does not rescue delegation when there is no context to
save; the depth condition from `v5-context-locality-2026-09-19` is intact and load-bearing.

**Speed is still not achieved.** 285.1 s against the native arm's 324.6 s is a 12 % improvement and no better than the
sonnet-worker arm's own 386 s → the variance here is larger than the effect. `maxParallelWorkers` is still 1, so the
workers run in series. The token half of the goal is met; **the speed half is not**.

**This is the forced arm.** Gate A did not admit, and Gate B patched nothing — `attempted=2 patched=0` on the loaded
cell. Every number above is what the mechanism can do when told to, not what it currently does. Turning −82 % from
reachable into actual is the gates' problem, and `v5-fanout-2026-09-19` is where that stands.

## Not settled here

- One repetition per cell. The direction is now measured three ways and the magnitude is still a single observation.
- Forcing every worker to `haiku` is more aggressive than the fan-out's own 3-of-6 split, and it passed — so on this job
  the selectivity was not load-bearing. That is one job, and a job whose tasks are unusually well specified.
- The checker grades the finished repository. It does not see whether a worker took a worse route to the same place,
  which would show up as turns or rework rather than as a failed check.
