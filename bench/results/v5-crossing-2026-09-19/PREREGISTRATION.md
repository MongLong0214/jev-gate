# Pre-registration — where does delegation start paying? Written before the run (2026-09-19)

`delegationDepthFloor` ships at 300,000 and that number is derived, not measured: the only end-to-end points are
~55K (delegation loses) and ~390K (delegation wins by about 60 %). The 13-note case has since been measured at
179–181K, but only with the gate refusing, so no delegated cost exists there.

**What is measured:** `jev_forced_orchestration` against `sonnet_native` at two depths below the one already done —
`wide-validators-primed-13` (~180K) and `wide-validators-primed-21` (depth unknown, expected ~290K). Forced, because
at 180K the gate refuses and would otherwise produce no delegated cell at all.

**Cells:** primed-13 forced ×2 (native ×2 already exist from the shallow run and are reused); primed-21 native ×2 and
forced ×2. Six new cells.

Fixed before the run:

1. A cell is invalid if `context_at_job_prompt` is below 150,000 for the 13-note case or below 200,000 for the
   21-note case — that is, if the priming did not land near its expected depth. The achieved depth is reported
   whatever it is.
2. **Nothing under 15 % is claimed.** This bench resolves ~10 % at constant plan size and ~47 % otherwise
   (`v5-plan-variance-2026-09-19/`). The outcome is therefore a direction per depth — delegation clearly cheaper,
   clearly more expensive, or indistinguishable — not a percentage.
3. Plan size is recorded per cell. Cells are compared against native, which has no plan, so plan size enters as
   spread within the forced arm rather than as a confound between arms.
4. **The floor is not moved on this run's result.** If delegation is clearly cheaper at 180K, that is recorded as
   evidence the 300,000 floor is too conservative, and moving it is a separate decision with its own justification —
   not a number tuned to a measurement.
5. If both depths are indistinguishable, the honest conclusion is that this bench cannot locate the crossing, and the
   floor stays derived.
