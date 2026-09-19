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
