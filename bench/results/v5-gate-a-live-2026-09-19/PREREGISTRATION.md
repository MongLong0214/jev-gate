# Pre-registration — the first real Gate A admission, written before the run (2026-09-19)

Every cost figure in this repository rests on `jev_forced_orchestration`, where admission is forced and no Gate A
judgement runs. This run asks whether the shipped gate admits a job on its own, at a depth where delegation is known
to be cheaper.

**Arm:** `jev_hierarchy` (plugin, `mode=auto`, nothing forced). **Case:** `wide-validators-primed-30`.
**Config:** the shipped defaults with `admissionQuestionShape: atomic` and `delegationDepthFloor: 300000`.
**Repetitions:** 2.

**Baseline:** the four cells of the third primed run (`run-2026-09-19.json`) — same case, same priming prompt, same
build, same day. `sonnet_native` job turn $2.7401 / $2.6585; `jev_forced_orchestration` $1.2338 / $1.2766. No new
native or forced cells are run, and if the baseline is questioned the comparison is re-run rather than argued.

Fixed before the run:

1. A cell is invalid if `context_at_job_prompt` is below 250,000, as before.
2. **The primary outcome is binary and is not about cost**: does the trace record an `admission_result` with
   `decided: true` and `shape: orchestrated` for the job prompt? Anything else — a veto, a floor, an invalid answer, a
   transport failure — is a refusal, and its recorded reason is the result.
3. The priming prompts will each be judged by the same gate. They are expected to be refused (`answer_only`, or too
   small), and a refusal there is not a failure of this run: only the job prompt's decision is the outcome.
4. If admitted: the job turn cost is reported against both baselines. `jev_hierarchy` within noise of
   `jev_forced_orchestration` (under 10 %) means the gate costs nothing to consult; above `sonnet_native` means
   admitting was worse than not.
5. If refused: the reason is recorded and no cost claim is made from these cells. The next step is then the question
   the refusal names, not another run of the same shape.
6. Worker count is recorded per cell as a covariate, because its spread has been larger than the effect being
   measured. It is not controlled here and no claim is made that it is.
