# Outcome labels for Jev-"complex"/Opus-routed jobs — preregistration (2026-10-22, before any cell ran)

Jev (jev-1.14.0, spawn scope, shipped policy) routed these checker-backed jobs to Opus: orbit-core, mini-sql (run 1:
Sonnet 6/6 pass, Opus 6/6 pass), search-race, ttl-cache, job-queue, todo-priority (this run). Other checker jobs
(quote-pricing, status-count, cart-total, wide-validators, space-sim) Jev already routed to Sonnet.

Run 2: sonnet_native vs frontier_native(opus), 2 reps, bench/cases.json --only search-race,ttl-cache and
bench/v4/cases.json --only job-queue,todo-priority. Same limits as run 1. Denominator = planned rows.

Outcome label per job: "routine-sufficient" if Sonnet passes every rep; "needs-deep" if Sonnet fails any rep that Opus
passes; "unresolved" if both fail. The rubric change (routine covers spec-complete implementation verified by checks)
ships only if it moves routine-sufficient jobs to Sonnet without moving needs-deep jobs or golden dev/test/spawn
complex items below complex (test split run once, after dev tuning).
