# Pre-registration — primed 30-note cell, written before the run (2026-09-19)

Question: with the job prompt submitted at real depth in its own turn, does jev_forced_orchestration still cost less
than sonnet_native, as it did when the priming happened inside the job turn (-57 %)?

Arms: sonnet_native, jev_forced_orchestration. Case: wide-validators-primed-30. Two repetitions each, four cells.
Root model sonnet for both. maxParallelWorkers 1, routeQuestionShape composite (the shipped defaults).

Recorded before the run, and not to be changed after seeing results:

1. A cell is INVALID, and excluded with its reason, if `context_at_job_prompt` is null or below 250,000 -- the priming
   did not land, so the cell did not test what it was built to test. Invalid cells are reported, not silently dropped.
2. The comparison is on the job turn alone: cost = last turn total - the total after the last priming turn. The
   session total is also reported.
3. Checks must pass in both arms for a cost comparison to mean anything. A failing arm is reported as failing.
4. The depth floor is not consulted by the forced arm by design, so the forced arm here measures what orchestration
   costs at this depth, not what the gate decides. Gate A's own decision is step 3.
5. A sign that does not reproduce falsifies the claim that the -57 % was about depth.

## Amendment, written before the second run (2026-09-19)

The first run was invalid under rule 1: `context_at_job_prompt` was 27-28K in all four cells. Cause, found in the
stream: closing stdin with every prompt in it makes the host append the waiting prompts to the turn already running,
so priming and job became one turn -- the same condition the loaded case already had. Prompts are now written one at a
time, on the `result` event that ends the previous turn. Verified on a three-prompt session: three separate turns, and
the third prompt's echo stood at 61,809 context after four files were read.

Rules 1-5 above are unchanged and still govern. The invalid run is recorded in `invalid-run-2026-09-19.json` and its
numbers are not used as a result.
