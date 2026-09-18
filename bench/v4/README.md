# bench/v4 — V4 evaluation jobs (#17)

Four complete coding jobs, one per family, defined **before** any V4 model run and held out from V4 policy development
(the V4 route wording and thresholds come from #10 unchanged; the only V4 tuning evidence is the V3 A/B in `src/jev.ts`).

| id | family | shape |
|---|---|---|
| `cart-total` | localized bug + API-preserving change + regression tests | three defects in one function; tests must fail on the broken source |
| `todo-priority` | cross-file feature touching model, serialization and view | new field, format version bump with v1 migration, ordered rendering |
| `space-sim` | compound simulation: deterministic time, pause/time-scale, camera, HUD | one existing module, two new modules, HTML wiring (not auto-graded) |
| `job-queue` | asynchronous bug: investigation, error propagation, integration | swallowed errors stall the queue; onError, drain, concurrency |

`fixtures/<id>` is the broken/incomplete start the model receives. `checkers/<id>.mjs` are trusted behavior checks with the
project protocol (`--describe` / `<evalDir>`); `regression_tests_detect_bug` checks run the candidate's own tests against
the unfixed source and require them to fail. `reference/<id>` satisfies every disclosed requirement and is used only by the
offline regression that proves each checker fails the fixture and passes the reference; targets never see it.

Development/smoke history: `bench/cases.json` (the four V3 fixtures). Browser interaction for `space-sim` is out of the
automated checker's scope and is declared so in the request.

```sh
node dist/bench/run.js --cases bench/v4/cases.json --out /outside/repo/v4-run-1                       # plan only: stdout, no writes, no inference
node dist/bench/run.js --cases bench/v4/cases.json --out /outside/repo/v4-run-1 --execute --max-sessions 20   # 4 jobs × 5 arms
node dist/bench/report.js --run /outside/repo/v4-run-1
node dist/bench/run.js --regrade --cases bench/v4/cases.json --out /outside/repo/v4-run-1               # re-score saved snapshots, model 0
```
