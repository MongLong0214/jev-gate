# bench/

Small, dependency-free JS fixtures for the four-arm comparison in [#6](https://github.com/MongLong0214/jev-gate/issues/6).

- `cases.json` — manifest (`{version:3, cases:[{id, group, fixtureDir, request, setup, checkFile}]}`); paths are relative to this file.
- `fixtures/<id>/` — the broken starting point the model receives (copied per cell; the original is never modified).
- `checkers/<id>.mjs` — trusted behavior checks. `--describe` prints the required check ids; `<evalDir>` prints `{checks:[{id,pass}],environmentError}`.
- `reference/<id>/` — a known-good solution used only by the offline regression (`tests/bench-fixtures.test.ts`) to prove each checker fails the fixture and passes the reference. Targets never see it.

These are development fixtures, one per failure group, not production incidents and not a general benchmark. Results on them are descriptive statistics for this task set only.

```sh
node dist/bench/run.js --cases bench/cases.json --out /outside/repo/run-1            # plan only, 0 inference
node dist/bench/run.js --cases bench/cases.json --out /outside/repo/run-1 \
  --max-sessions 16 --timeout-ms 600000 --max-turns 40 --seed 42 --execute            # 4 cases × 4 arms
node dist/bench/report.js --run /outside/repo/run-1                                    # reads files only
```
