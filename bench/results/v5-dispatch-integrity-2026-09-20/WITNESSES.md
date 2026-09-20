# Dispatch integrity: the before/after witnesses — 2026-09-20

This is the experiment an external reviewer recommended in place of another depth ladder: a
before/after fault-injection replay, run deterministically, with **no stochastic spend**. Its
claim is narrow and it is the only kind of claim available here — *the old build fails these
witnesses and the repaired build passes them*. It says nothing about cost, and nothing about
whether the product is worth using.

## Method

Each defect gets one witness: a test that reproduces the fault through the hook's real event
path, not through a unit call to the function that has the bug. The witnesses were written
against the repaired build, then run against the **pre-fix source** by checking out `src/` at
`5d4ba7d` while keeping the new tests, and run again against the repaired source.

```
git checkout 5d4ba7d -- src/     # tests/ stays at the new commit
npx vitest run tests/hook.test.ts tests/bench-ingest.test.ts
```

This is not a proof that the repairs are complete. A witness proves the specific fault is gone;
it does not prove the class is.

## Result

**12 witnesses. 12 fail before, 12 pass after.** Full suite after: 563 passing.

| # | Witness | Fault it reproduces | Before | After |
|---|---|---|---|---|
| 1 | a rework whose call fails covers the accept it replaced | `PostToolUseFailure` wrote `contract_hash: ''`, so `currentReceipt` could not see the failure and the superseded accept still read as the task's result. A dependent dispatched on a dependency nobody finished | FAIL | pass |
| 2 | records the numbers the atomic gates decide on | the trace whitelist carried only the fields a *choice* answer has, so the shipped atomic Gate A could not be reconstructed from its own observations | FAIL | pass |
| 3 | carries the request on a preserved dispatch | composition ran after the routing checks, so every preserve reason dispatched a worker with the coordinator's brief and no statement of the work | FAIL | pass |
| 4 | …through a failed Gate B | same, parameterised on `http_other` | FAIL | pass |
| 5 | …through native mode | same, parameterised on `mode_native` | FAIL | pass |
| 6 | …through a missing key | same, parameterised on `key_missing` | FAIL | pass |
| 7 | …on a pinned dispatch, leaving the pin as called | same, and the pin must survive the patch | FAIL | pass |
| 8 | refuses a second dispatch while the first is running | the single path ran none of the dispatch conflict checks the hierarchy re-runs under the lock, so two Agent calls in one assistant message both reserved | FAIL | pass |
| 9 | refuses a dispatch superseded while Jev was answering | the lock is not held across HTTP and this path never re-confirmed ownership afterwards | FAIL | pass |
| 10 | routes the planner on the request, not the brief | the Gate A2 state field named `request` was being given the coordinator's brief; observed 2026-09-19, a 771-character fix instruction chose the tier for replanning a whole job | FAIL | pass |
| 11 | a size score off the question's own scale is invalid | `size: 999` cleared the floor and admitted, so an answer the gate cannot read counted as evidence for orchestrating | FAIL | pass |
| 12 | counts a repeated message id and an unreadable counter | the stream sum added missing counters as zero and never checked message identity, so it could not say whether it was de-duplicated | FAIL | pass |

(11 lives in `tests/admission-atomic.test.ts` and was verified in the same way at the earlier
commit; 1–10 and 12 are listed above in the order the suite reports them.)

## What this does not establish

- **Nothing about cost.** No cell was run and no dollar was spent. The withdrawn depth ladder is
  still withdrawn and none of its percentages are rehabilitated by this.
- **Nothing about the class.** Witness 3 fixes seven preserve paths on one shape. It does not
  prove no other path drops its packet; the reviewer's structural point — prepare the packet
  before routing, so routing only decides a model — is what generalises, and only for paths that
  now share that structure.
- **Nothing about a fail-open host hook.** Every guarantee here is a guarantee about controlled
  code paths. A hook that is killed, or that times out, still dispatches whatever the host had.
- **Nothing about semantic correctness.** The hierarchy failure recorded in
  `v5-context-vs-decomposition-s1-2026-09-19` — workers implementing a wrong output shape, writing
  tests that agree with it, and producing accepted receipts — is untouched by any of this.
  Tightening receipt bookkeeping cannot repair a shared misreading of the request.

## Cost

$0. The whole replay is deterministic and runs in about ten seconds.
