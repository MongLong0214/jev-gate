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

## Router arms (#45)

`--arms router` selects exactly three arms, not mixed into the default set or `lean`:

- `router_native` — plain host, no plugin: the frontier root (`--frontier-model`) at `--base-effort`. This is the
  session the Router is meant to make cheaper, so it is ordinary Claude as the owner runs it, not a Sonnet session
  the Router has little to lower from.
- `router` — the same root and starting effort, with the `jev-gate-router` plugin (`mods/router/`) enabled via
  Function Hooks. This is a **different** plugin
  from the legacy `jev-gate` one the other arms use; `--plugin-dir` for it always resolves to `<repo>/mods/router`.
- `router_fixed` — the same root, no Router, a fixed `--effort <level>` chosen up front with `--fixed-effort`, so a
  Router win can never be read as "just an effort change" against `router_native`.

Neither effort has a default: a plan that selects `router` or `router_native` without `--base-effort`, or
`router_fixed` without `--fixed-effort`, is refused. The root model has one, and it is not the owner's:
`--frontier-model` still defaults to `fable`, so a run for the owner's configuration passes `--frontier-model opus`.

```sh
node dist/bench/run.js --cases bench/cases.json --out /outside/repo/run-2 \
  --arms router --frontier-model opus --base-effort xhigh --fixed-effort high           # plan only, 0 inference
node dist/bench/run.js --cases bench/cases.json --out /outside/repo/run-2 \
  --arms router --frontier-model opus --base-effort xhigh --fixed-effort high \
  --max-sessions 12 --timeout-ms 600000 --execute
```

The `router` arm launches with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, `--plugin-dir <repo>/mods/router`, a per-cell
`--settings <cell dir>/router-settings.json` (`{"pluginConfigs":{"jev-gate-router@inline":{"options":{"enabled":true,"logDecisions":true}}}}`)
and `--debug-file <cell dir>/router-debug.log`. The TypeSafe key never goes in that file — it reaches the plugin only
through the `TYPESAFE_API_KEY` env var. All four flags (`--plugin-dir`, `--settings`, `--debug-file`, `--effort`) are
verified against `claude --help` on Claude Code 2.1.283. The Router options, the plugin dir and both efforts
are frozen in the plan's `cli.router_policy` before anything executes, the same convention as
`lean_packet_policy`.

**What is ingested.** The runner parses `jev-router {json}` lines out of each cell's `router-debug.log` (any other
debug line, and a malformed or truncated last line, is tolerated and counted in `unparsable_lines` rather than
dropped silently or failing the cell). It keeps, per cell: every root step's assessed/proposed/applied/observed
model and effort with skip and stop reasons and their counts, every spawn's requested/resolved model, denial and
`model_mismatch` count, and the Router's own Jev request usage (`jev_attempts`, `jev_responses_known`,
`jev_input_tokens`, `jev_cost_usd`) — a **third** cost producer alongside the legacy gate and Lean, summed once and
never double-counted.

**What stays unknown.** The Router's Jev usage is carried on its `root`/`spawn`/`late` debug-log records only when
the Jev HTTP response body itself included a `usage` object (`mods/router/hooks/client.ts`'s `parseUsage`) — it is
never invented when absent. A cell where the Router ran but sent zero Jev requests reports a **known** zero; a cell
where it sent requests but never observed all of their usage (a timeout, a late reply that never arrived) reports an
**unknown** total, not zero. `root_result`'s own `usage` field is the *routed Claude call's* token counts (never
priced as Jev cost) — kept only as a raw per-step observation, distinct from the Jev request usage above. As of PR #49
(`mods/router/hooks/router.ts` `hostSupported`), any `2.1.N` with `N >= 282` is accepted, so on this machine's
Claude Code 2.1.283 spawn routing is **live, not a structural no-op** — the Router has already patched real spawns
and root turns on an installed 2.1.283 host outside this bench (`bench/results/host-obs-2026-09-27/`, `HANDOFF.md`).
None of that came from this runner, though: nothing here executes anything, so the Router table in the report still
carries only a mechanism/cost reading of whatever a real `--execute` run captures — there is no savings headline for
these arms.

Also new in PR #49: the host's debug log redacts the value of any key containing "token" to a bare `[REDACTED]`,
which breaks JSON parsing outright, so the Router logs `input`/`output`/`cache_read`/`cache_creation` instead of the
`_tokens`-suffixed names. `ingestRouterLog` reads the new names and treats a `[REDACTED]` line as unparsable JSON
(counted in `unparsable_lines`), never as zero usage; the old key names are still read as a fallback for a line that
happens to parse as JSON under them, which a genuinely redacted line never does.
