# bench/v5 — V5 evaluation jobs (#29)

Two coding jobs defined before any V5 model run, plus `admission-set.json` for the offline Gate A calibration.
Each job ships a manifest fragment `cases.<id>.json` (`{ "version": 5, "cases": [ … ] }`), the broken start the target
receives in `fixtures/<id>`, a trusted behaviour check in `checkers/<id>.mjs`, and a reference in `reference/<id>` that
is used only by the offline regression proving the check fails the fixture and passes the reference. Targets never see
`reference/`. `checkers/_lib.mjs` carries the project protocol (`--describe` / `<evalDir>`, exit 0 + JSON); per ADR #22
A11 a check body may return `{ passed, reason }` so a failure names the behaviour that regressed.

## orbit-core

The calculation core of a 2D gravity simulation, no rendering: seven ESM modules under `src/`, Node 22, `node --test`,
no dependencies. SI units throughout and `G` always supplied by the caller.

| module | what it owns | difficulty |
|---|---|---|
| `clock.js` | fixed step, accumulator, cap and clamp, pause, time scale | medium — the accumulator/cap/clamp rule is stated with a worked example, so the work is reading precisely |
| `physics.js` | velocity-Verlet (kick-drift-kick), no softening, energy, momentum | hard — a first-order step passes casual tests and misses the drift bound by 26× |
| `collisions.js` | transitive momentum-conserving merge, order-independent | hard — connected components in one call, and id-ordered sums for bit-identical results |
| `snapshot.js` | closed-schema serialize/restore, exact doubles, `SnapshotError` | easy — mechanical once the schema is read |
| `camera.js` | world↔screen inverses, cursor-anchored `zoomAt`, `pan` | medium — `zoomAt` needs the centre solved for, not guessed |
| `hud.js` | one exact line, `T+HH:MM:SS.mmm x1.0 RUNNING bodies=n E=…` | easy — pure formatting, but byte-exact |
| `simulation.js` | clock + integrator + merge, snapshot, bit-identical replay | medium — composition only, and it fails if any core is wrong |

The fixture starts with four of the seven modules present and wrong (clock ignores pause and drops the remainder,
physics integrates with Euler, `screenToWorld` is not the inverse of `worldToScreen`, the HUD line is a constant) and
three missing entirely. Its five existing tests are the disclosed bar: two pass on the fixture, all five on the reference.

### Checks (all required, `checkers/orbit-core.mjs`)

`modules_load`, `clock_steps_and_accumulator`, `clock_pause_and_time_scale`, `physics_energy_drift_bounded`,
`physics_reversible`, `collisions_conserve_mass_and_momentum`, `collisions_transitive_and_order_independent`,
`snapshot_round_trip_exact`, `snapshot_rejects_unknown_fields`, `camera_transforms_invertible`,
`camera_zoom_at_keeps_anchor`, `camera_pan_shifts_view`, `hud_formats_exact_strings`,
`simulation_replay_bit_identical`, `simulation_restore_continues_run`, `test_suite_passes`.

Energy is checked only on the collision-free two-body orbit (m1=1e12 kg, m2=1e3 kg, r=1000 m, exact circular velocity):
merges are inelastic, so mass and momentum are what the merge checks assert. Measured on the reference: relative energy
drift **3.087e-14** over 20 000 steps at dt=1 s against the declared 1e-4 bound (10× the measured value is 3.1e-13, so
the bound clears the reference with room to spare while a first-order Euler step drifts 2.656e-3 and fails); the
reversed run returns to within **1.722e-15** of the start relative to r, against the declared 1e-6. A module the
candidate never wrote leaves its own checks unevaluated rather than scoring them as wrong behaviour, and a hung or
unimportable test suite is recorded as a failed `test_suite_passes` with the reason, not an environment error.

The whole check run takes ~0.2 s on the reference, well inside the 60 s budget.

`tests/bench-v5-orbit-core.test.ts` is the offline regression: the fragment parses with safe, contained paths, the
request text names no staffing, `--describe` matches what the checker reports, the reference passes, the fixture fails,
and four broken variants of a working solution each have to be caught by one named check while the rest still pass
(Euler → `physics_energy_drift_bounded`, pause ignored → `clock_pause_and_time_scale`, lossy merge →
`collisions_conserve_mass_and_momentum`, wrong energy precision → `hud_formats_exact_strings`).

## mini-sql

An in-memory SQL query engine, no dependencies: seven ESM modules under `src/`, Node 22, `node --test`. The request
states the whole grammar (precedence `NOT` > comparison > `AND` > `OR`, `*` `/` before `+` `-`, non-associative
comparison), the semantics (three-valued NULL, duplicate rows kept, inner join only, aggregates ignoring NULL except
`COUNT(*)`, stable ORDER BY with NULLs last ascending and first descending, LIMIT after the sort, case-insensitive
identifiers, binary string comparison, division always producing a float, division by zero NULL) and the exclusions
(subqueries, DISTINCT, HAVING, outer joins, LIKE, IN, BETWEEN, UNION, CASE, INSERT/UPDATE/DELETE, multiple statements).

| module | what it owns | difficulty |
|---|---|---|
| `errors.js` | `SqlSyntaxError` with `position`, `SqlSemanticError` | easy — two declarations, but every other check depends on the names |
| `lexer.js` | tokens with positions, case-insensitive keywords, `''` escape | medium — the doubled quote and the reported positions are where first attempts slip |
| `parser.js` | the full SELECT grammar, precedence, error positions, AST shape | hard — precedence climbing plus a position on every failure |
| `analyzer.js` | unknown/ambiguous names, GROUP BY rules, aggregate placement, ORDER BY aliases | hard — needs a scope the executor can reuse, and alias-before-column resolution |
| `executor.js` | scans, hash vs nested-loop join, three-valued NULL, grouping, stable sort, plan | hard — the join must emit left-input order whichever side was hashed, and NULL is unknown everywhere except `IS [NOT] NULL` |
| `db.js` | tables, typed inserts, indexes maintained on insert, `query`, `schema` | medium — mechanical, except that an index has to stay correct after later inserts |
| `format.js` | byte-exact table text, alignment, 6 significant digits, `(N rows)` | easy — pure formatting, but exact to the space |

The fixture starts with five of the seven modules present and wrong (the lexer ends a string at the first inner quote
and only recognises uppercase keywords, the parser handles `SELECT cols FROM t [WHERE col op literal]` and nothing else,
the executor is a single-table scan whose `=` treats NULL as a value, the formatter left-aligns everything and omits the
row count, `db` has no index at all) and `analyzer.js` and `errors.js` missing entirely. Its six existing tests are the
disclosed bar: two pass on the fixture, all six on the reference.

### Checks (all required, `checkers/mini-sql.mjs`)

`modules_load`, `lexer_tokens`, `parser_ast_shape`, `select_projection_and_arithmetic`, `where_filtering`,
`null_three_valued`, `join_inner_hash`, `join_nested_loop`, `group_by_aggregates`, `order_by_sorting`,
`limit_after_order_by`, `order_by_stability`, `syntax_errors_with_positions`, `semantic_errors`, `explain_index_scan`,
`explain_seq_scan_and_join_plan`, `format_table_exact`, `case_insensitive_identifiers`, `test_suite_passes`.

The checker holds a fixed dataset (`users` 10 rows, `orders` 14, `products` 6, NULLs in every nullable column, indexes
on `users.city`, `orders.user_id`, `products.category`) and runs **40 queries** against expected rows. Seventeen of those
expectations are computed inside the checker by an independent brute-force evaluator — plain loops, manual grouping and
its own stable NULL-aware sort over the raw arrays — so the hardest results (joins, multi-key ordering, grouped
aggregates over a join) are not taken from the reference. Six syntax errors are checked for class **and** position, two
more semantic families for class; the plans cover index vs sequential scan, hash vs nested loop and a two-join tree;
three formatter outputs are compared byte for byte; ORDER BY stability is asserted on four queries whose keys tie. A
hung or unimportable suite is recorded as a failed `test_suite_passes` with the reason, not an environment error.

Measured on the reference: **19/19 checks pass in ~0.15 s** (the 60 s budget is never approached). On the fixture the
run stops at `modules_load` (`src/errors.js` missing), leaving the rest unevaluated — a fail with no environment error.

`tests/bench-v5-mini-sql.test.ts` is the offline regression: the fragment parses with a safe id and contained paths, the
request text names no staffing, `--describe` matches what the checker reports, the reference passes, the fixture fails,
and five broken variants of a working solution are each caught by one named check (NULL comparing equal to NULL →
`null_three_valued`, a sort that reorders ties → `order_by_stability`, a hash build keeping one row per key →
`join_inner_hash`, a planner that never reports an index → `explain_index_scan`, a formatter that left-aligns numbers →
`format_table_exact`).
