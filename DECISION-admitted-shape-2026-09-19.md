# Decision to make — should `admittedShape` default to `single`? — 2026-09-19

**Status: recommendation, not a decision. Nothing is changed by this file.** `admittedShape` still defaults to
`hierarchy`, as the pre-registrations of both runs require (`v5-context-vs-decomposition` rule 11,
`v5-single-vs-native` rule 10: a bench result is not a release). The owner decides; this is the evidence, the
counter-case and a recommendation, written before any change.

## What is being decided

An admitted turn currently becomes: planner (opus, read-only) → plan → task contracts → workers → receipts →
deterministic acceptance → replan path. The alternative already implemented and measured is: **one worker, carrying
the user's request verbatim, with no plan and no contract.** Gate A, the depth reader, the root guard and Gate B's
tier choice are identical in both.

## The case for `single` — quality and failure surface first

**Quality, every cell recorded on this repository's two jobs:**

| shape | wide-validators | orbit-core | total |
|---|---|---|---|
| `jev_single` | 2/2 (stage 1) + 2/2 (this run) | 2/2 (this run) | **6/6** |
| `jev_hierarchy` | 2/2 (build `c2c9bd1`-era) + **1/2** (build `2042170`) | **1/2** (build `000f28c`-era) | **4/6** |
| `sonnet_native` | 2/2 + 2/2 | 2/2 | 6/6 |

**The two hierarchy failures were failures of the machinery that `single` does not have**, and neither was a worker
doing its job badly:

- `wide` r1 (`v5-context-vs-decomposition-s1`): the plan froze what the request left open — its `data_shapes` said
  `"new empty-array case: { ok:false, field:'<name>' }"` and the request never mentioned `reason` — so all twelve
  workers uniformly omitted a field the checker required. **This one failed silently**: receipts `accept: 3`, plan
  `ready`, job outcome `completed`. The job said it was finished.
- `orbit` r1 (`v5-job2-orbit`): five planner calls, two invalid replies, one failed replan, a plan finally accepted
  and then **zero workers dispatched**; the working tree was byte-identical to the fixture. This one did *not* fail
  silently — the state ended `incomplete` with no receipts — but it consumed a full job turn and produced nothing.

`single` has one failure point: the worker. There is no plan to be wrong, no contract to freeze a wrong reading, no
replan loop to exhaust, and no way to spend a job turn producing nothing while a plan is being repaired.

**Cost is supporting evidence, not the case.** On `wide` the saving is large and clean (−71.0 %, arms not touching).
On `orbit` the 20.4 % margin is smaller than either arm's own cell-to-cell spread and the nearest two cells differ by
$0.011. **Cost alone does not carry this decision**, and the recommendation does not rest on it.

**The mechanism is now named.** The saving is not fewer tool calls — Bash counts, writes and edits match between
arms. It is **root turns taken at depth**: 42/43 → 11 on wide, 27/22 → 13/17 on orbit. What is expensive in a ~390K
session is a turn taken in that session, and this shape has a fresh worker take them instead.

## The case against, at equal weight

1. **No run has compared `single` and `hierarchy` on cost.** Stage 1 had all three arms on one build, and rule 3
   withheld the comparison because the arms' pass counts differed. We know `single` beats *native*; we do not know
   whether splitting adds or subtracts on top of the context move.
2. **`single` accepts on weaker evidence.** With no contract there is nothing for code to check, so its accept is
   the worker's own `status: done` — recorded and rendered as reported, not verified. `hierarchy`'s acceptance is
   deterministic against declared checks. Adopting `single` means the plugin itself asserts less about the result.
   (In the cells measured, the external checker agreed 6/6 — but that is the checker's word, not the plugin's.)
3. **`single` is slower on every cell measured** — about 40–48 % on the means of both jobs. If wall-clock matters
   more than tokens for a given user, this default is worse for them.
4. **Neither shape has been tested where splitting is actually necessary.** Both jobs fit one worker. A request
   whose work exceeds one worker's context has never been run in either shape here, and that is precisely the case
   `hierarchy` exists for. `single`'s ceiling is one worker; it is untested at that ceiling.
5. **The sample is small and partly across builds.** Six cells per shape, two job shapes, and the hierarchy row
   mixes three builds. The wide 2/2 hierarchy cells predate three behaviour-changing commits.
6. **The shipped default has never been the thing measured most.** Most figures in `HANDOFF.md` come from
   `hierarchy` at depth, and flipping the default means the documented numbers describe a configuration that is no
   longer the default.

## Recommendation

**Flip the default to `single` for admitted turns; keep `hierarchy` as a supported option, with its code, tests and
documentation intact.**

The reasoning is not that measurement rejected `hierarchy` — it did not, and the sample is too small for that claim.
It is that with both defaults imperfectly supported, the one to ship by default is the one with **fewer failure
points, the quality record that is confirmed rather than mixed, and a failure mode that is loud** (one worker either
did the work or did not) rather than one that can report `completed` over a contract that was wrong.

Two things must go with it, or the recommendation is worse than doing nothing:

- **`hierarchy` stays reachable and maintained** (`admittedShape: "hierarchy"`), and nothing about the planner,
  contracts or receipts is deleted. Deleting or deprecating that path alongside the flip was considered and is
  rejected here: coupled and oversized jobs are an open question, not a closed one, and the duplication finding in
  `DIAGNOSIS.md` is an argument for keeping the split available rather than for removing it.
- **The weaker acceptance is documented where a user meets it**, not only in the code: under `single`, the plugin
  reports what the worker reported and verifies nothing itself.

## What would change this recommendation

- A job whose work does not fit one worker, where `single` fails and `hierarchy` completes.
- A pre-registered run comparing `single` and `hierarchy` directly on cost with equal pass counts, showing
  `hierarchy` at or below `single`.
- Any further `single` cell failing its checker while the same job's native cells pass.
- Evidence that the weaker acceptance lets a wrong result through where the deterministic one would have caught it —
  which is the exact converse of the wide r1 failure, and equally worth looking for.

## Added after this file was written: the depth ladder, and a second defect of the same class

`bench/results/v5-depth-ladder-2026-09-19/` (pre-registered, run the same evening) adds two facts that belong to
this decision, one on each side.

**For the recommendation:** the `single` shape is **41.8 % cheaper than native at 193K context**, below the floor
the product will act at, on a rung where the native arm's own cells sit 0.6 % apart. The saving is not confined to
~390K sessions. It also makes explicit that `delegationDepthFloor: 300000` was derived from **hierarchy**
measurements and has never described this shape — a flip does not change the floor, but it does mean the floor is
now a number set for the path that would no longer be the default.

**Against it, or at least as a condition on it:** the same run found the second defect of the same class on this
path, after the missing receipt in `ed2a419`. A worker's entire reply was discarded because a check id it named
itself contained a space, throwing away 86.6 seconds and 43 tool calls, and the path was counting dispatch
attempts without reading the bound it counted toward. Both are fixed in `f2b3256` with tests. The pattern is what
matters for this decision: **the contractless path keeps inheriting machinery that assumes a contract**, and each
instance was found by running it rather than by review. The shape proposed as the default has less running time
behind it than the one it would replace.

That does not reverse the recommendation — the quality record and the failure-surface argument are unchanged, and
both defects were in the bookkeeping around the work rather than in the work. It does say the flip should carry the
expectation that a third one exists.

## Evidence

- `bench/results/v5-single-vs-native-2026-09-19/` — this run: 8 cells, 8 passes, both jobs.
- `bench/results/v5-context-vs-decomposition-s1-2026-09-19/` — stage 1: three arms on one build; the wide r1
  contract failure and why no receipt could catch it.
- `bench/results/v5-job2-orbit-2026-09-19/` — orbit r1: five planner calls, zero workers, nothing written.
- `bench/results/v5-replan-bound-2026-09-19/DIAGNOSIS.md` — duplication scales with coupling, which is the argument
  for keeping `hierarchy` available.
- `bench/results/v5-depth-ladder-2026-09-19/` — the depth ladder: 41.8 % at 193K, the session limit that cut it
  short, and the check-id defect it found.
