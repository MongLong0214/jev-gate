# Jev "complex" vs outcome — 2026-10-22

Both preregistrations were written before any cell ran. Host: Claude Code 2.1.307, macOS, subscription, headless,
sequential, no plugin (`sonnet_native` / `frontier_native` with `--frontier-model opus`), host default effort,
`--max-turns 60 --timeout-ms 1500000`. Cost is the host's notional `total_cost_usd`, not a bill.

## Coding jobs Jev routed to Opus

Jev capability is `jev-1.14.0`, spawn scope, shipped policy, old rubric.

| job | Jev complex | Opus pass | Sonnet pass | Opus $ (mean) | Sonnet $ (mean) | Sonnet/Opus |
|---|---|---|---|---|---|---|
| orbit-core | 0.57 | 3/3 | 3/3 | 0.820 | 0.448 | 55% |
| mini-sql | 0.66 | 3/3 | 3/3 | 1.218 | 0.687 | 56% |
| job-queue | 0.92 | 2/2 | 2/2 | 0.268 | 0.148 | 55% |
| todo-priority | 0.72 | 2/2 | 2/2 | 0.337 | 0.165 | 49% |
| search-race | 0.48 | 2/2 | 2/2 | 0.215 | 0.114 | 53% |
| ttl-cache | 0.45 | 0/2 | 0/2 | 0.221 | 0.098 | unresolved (both fail `expired_entry_removed`) |

A pass means the job's checker passed with zero failed checks. Five of five resolved jobs are Sonnet-sufficient. The
other checker jobs (quote-pricing, status-count, cart-total, wide-validators, space-sim) Jev already sent to Sonnet.

## Rubric correction (`src/router-selection.ts` CAPABILITY)

All six jobs spell out the cause or required behaviour and have checks; Jev read their topic (concurrency, migration,
compatibility, algorithm) as complex. The routine option now covers that work; complex keeps an uncertain cause,
constraints the request leaves open, live compatibility, permission or money logic, open algorithm design and reviews.

| set | old rubric | new rubric |
|---|---|---|
| the six jobs (+ owner-preamble variants), 13 | 4 to Sonnet | 13/13 to Sonnet |
| fresh held-out (`holdout.json`, 12 + 6 injection probes, labelled before the run) | — | 18/18 exact, 0 under |
| frozen test, 84 | 82 exact, 0 under, 2 over | 83 exact, 0 under, 1 over |
| dev, 84 | 82 exact, 1 under, 1 over | 82 exact, 0 under, 2 over |
| spawn, 12 (+5 outcome items) | 12 exact | 16/17 exact, 1 over (`s-r04`, a lock probe) |

An intermediate wording read the frozen test split once and moved one injection probe (`p13`, open CRDT design) to
Sonnet; it was not shipped, and the fresh held-out set was written before the shipped wording ran.

## Not settled here

- Two to three repetitions per job and well-specified jobs only; review, intermittent-failure and live-migration work
  stays complex and was not outcome-tested.
- A headless root session stands in for a spawned subagent.
- Codex shares the rubric; its routine/complex models were not outcome-tested.
- No live saving is claimed. The 48 h trace before the change had about $233 notional of child Opus spend kept as
  complex; how much of it the new boundary moves is measured after release.
