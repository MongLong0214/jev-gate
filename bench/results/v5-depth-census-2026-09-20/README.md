# The floor is not the blocker — a census of how deep real sessions actually get (2026-09-20)

`$0`, offline, read-only. Scanner: `scripts/depth-census.mjs`. Every `*.jsonl` under `~/.claude/projects`, depth summed
by the definition `src/depth.ts` ships (`cache_read + cache_creation + input`, sidechain lines skipped).

## This supersedes the narrow reading in `ff95cf8`

That commit measured the three sessions running at 16:22 and reported that none had ever reached the floor, peaking at
267,024. **Scoped to those three that is still true, and as a picture of the fleet it was wrong.** Three young sessions
are not the population. The census below is the population.

## All transcripts

| | |
|---|---|
| transcripts | 20,869 |
| sessions carrying usage | 461 |
| turns | 268,322 |
| **turns at or above 300,000** | **183,861 — 68.5 %** |
| sessions reaching 300,000 | 69 of 461 |
| deepest turn observed | **999,947** |

| band | turns |
|---|---|
| < 100K | 18,278 |
| 100–200K | 35,079 |
| 200–250K | 16,105 |
| 250–300K | 14,999 |
| **≥ 300K** | **183,861** |

## Compaction fires near 1M, not near the floor

295 compaction-shaped drops (a turn following a >150K turn at under half its depth). Median height **964,841**,
p90 999,434, max 999,947. The deepest turn was re-read with a full `JSON.parse` rather than the census regex and is
real: `claude-opus-5`, `cache_read_input_tokens: 999257`.

**So compaction does not preempt the gate.** Between the 300,000 floor and the ~1M ceiling there is a band roughly
700,000 tokens wide in which a session is eligible and compaction has not fired. The 267,024 drop reported in `ff95cf8`
was a drop inside a young session, not the auto-compact ceiling, and reading it as the ceiling is what produced the
wrong conclusion.

Recorded and not explained: `~/.claude/settings.json` carries `autoCompactWindow: 300000` with
`autoCompact.threshold: 0.7`, which does not describe the observed behaviour. The host's own counter and this
definition of depth are not the same number. No formula is fitted to the gap here.

## Since the plugin went live (2026-09-19)

| | |
|---|---|
| transcripts touched | 174 |
| of which reach ≥300K | 53 |
| turns | 70,872 |
| **turns at or above the floor** | **45,309 — 64 %** |

Real work sessions, not bench cells:

| session | turns | turns ≥300K | peak |
|---|---|---|---|
| repo-factory `41439a5d` | 28,932 | **22,106** | 967,028 |
| commitlore `8db38ace` | 12,550 | 9,449 | 966,614 |
| logic-pro-mcp `60ecf478` | 11,206 | 8,765 | 969,353 |
| agent-operator-score `48bdee6b` | 2,178 | 1,437 | 965,622 |

`repo-factory 41439a5d` has a jev-gate job state file. Its generations are `direct`.

## What this makes the open question

The gate's operating region is not hypothetical and it is not rare: **45,309 qualifying turns since the plugin went
live, and 0 orchestrated turns in 96 recorded generations.** The floor is not what is stopping it.

The immediate cause on the sessions running now is `key_missing`, which is tested before the depth read and preserves
every eligible call. Behind it sits the older observation in `v5-context-locality-2026-09-19`, made when a key was
present: *"`jev_hierarchy` answered `direct` on both jobs, as it has on every job and every real prompt put to it."*
Those are two different failures and this census separates neither. It establishes only that neither of them is the
floor.

## Two things were considered and decided against

**Moving `delegationDepthFloor` was considered and rejected.** The narrow reading argued for lowering it and was
wrong; the census argues that the floor is not the blocker at all. Neither is a measurement of a crossing point, so
changing the number on the strength of either was turned down rather than done.

**Reading the 267,024 drop as the auto-compact ceiling was considered and dropped.** It is what `ff95cf8` did. The
population puts the median compaction at 964,841 and the deepest turn at 999,947, so that reading is abandoned here.


## Not settled here

- Whether Gate A, given a key and a turn above the floor, orchestrates anything. No run in this census had both.
- Why the host's compaction counter disagrees with this depth definition.
- Whether 461 sessions on one machine describe anything but this machine.
- The compaction detector is a heuristic on consecutive turns; a manual `/compact` and an automatic one are not
  distinguished by it.
