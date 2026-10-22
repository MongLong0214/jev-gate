# Opus vs Sonnet on complex coding jobs — preregistration (2026-10-22, before any cell ran)

Question: 48 h router trace shows ~$233 of child-agent Opus spend kept by Jev capability "complex" (same_value).
Can those spawns go to Sonnet without losing quality?

Plan: bench/v5/cases.json (orbit-core 16 checks, mini-sql 19 checks), arms sonnet_native vs frontier_native
(--frontier-model opus), 3 repetitions, host defaults for effort, Claude Code 2.1.307, plugin not loaded,
CLAUDE_* env dropped by the runner. Denominator = the 12 planned rows; a missing/timeout cell is a failure, not excluded.
Limits identical for both arms: --max-turns 60, --timeout-ms 1500000, --max-cost-usd 60 (whole run).

Decision rule (fixed now):
- Change "complex" spawns to Sonnet only if, on both jobs, Sonnet's count of fully passing cells >= Opus's
  and Sonnet's total failed checks <= Opus's.
- Otherwise keep Opus for "complex" and report the gap.
Cost is reported from each cell's total_cost_usd (host notional price; subscription run).

Limits of this test: n=3 per cell, two well-specified jobs; a root session stands in for a spawned subagent.
Orbit-core passed 16/16 with Sonnet in earlier runs, so it may not discriminate; mini-sql has no prior native result.
