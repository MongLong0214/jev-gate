# Lean vs native auto-compact — pre-registered episodes (2026-10-12)

**Lean did not save more than 15 % on these episodes.** In all six paired repetitions `jev_lean` cost more than
`native_auto`, by 2.6–8.2 % per episode median, and ran 18 % longer. Jev's selection showed no value over recency that
this bench can resolve. The recency handoff did not save either: `recent_packet` cost 1.7–11.5 % more than
`native_auto`. Every cell passed both of its checkers. This run changes no default (rule 10).

Pre-registration and frozen inputs: [`PREREGISTRATION.md`](PREREGISTRATION.md). Full runner report:
[`report.md`](report.md). Per-cell rows: [`cells.tsv`](cells.tsv).

| episode | `jev_lean` $ | `native_auto` $ | `recent_packet` $ | lean vs native | lean vs recency | recency vs native |
|---|---:|---:|---:|---:|---:|---:|
| ep-inventory | 0.2861 | 0.2643 | 0.2689 | −8.2 % | −6.4 % | −1.7 % |
| ep-durations | 0.2542 | 0.2362 | 0.2633 | −7.7 % | +3.5 % | −11.5 % |
| ep-slugs | 0.3050 | 0.2971 | 0.3158 | −2.6 % | +3.4 % | −6.3 % |

Each value is the median of two repetitions of a five-request episode (three earlier requests, the measured request
and one follow-up). A negative percentage means the first arm cost more. All three episodes were valid under rules 1–3,
so every pair is adjudicated (rule 4). Under rule 5 none of these differences is quoted as a finding.

## What happened inside the lean arms

- **`jev_lean` never handed off.** Jev answered all 24 selections (HTTP 200) with `direct`: `no_effect` 20 times and
  `work_shape_unusable` 4 times. No packet was proposed, so the arm ran as native plus one Jev request and the lean hook
  per prompt. Those 24 requests cost $0.0076 in total. The extra Claude spend is larger than that (more cache reads per episode), and its source was not isolated.
- **`recent_packet` was never taken.** It proposed a packet on all 24 requests (largest 23 KB). The root model
  dispatched none of them, and 18 were recorded as not taken.
- So this bench measured lean's overhead, not its handoff. No executor started in any cell.

## Limits

- The episodes are small. Contexts peaked around 30–35 K tokens per request, and a whole episode cost about $0.27.
  Real root sessions on the owner's machine run far larger (p50 about 178 K tokens). Whether a handoff pays off at that
  size is not tested here.
- Two repetitions per arm and episode, one model (Sonnet 5.5 root), one machine.
- Run 1 of this protocol was stopped by the host's usage limit after four cells and is not pooled (see the addendum in
  `PREREGISTRATION.md`). Run 1 and run 2 together cost $1.22 + $4.98, under the $30 stop.

## Consequence for #214

#214 asked to integrate Lean into the default `auto` flow if the integration had a clear benefit. On this evidence it
has none: Lean made every episode slower and slightly more expensive and never changed what the root model did. Lean therefore stays an explicit opt-in mode (`mode: "lean"`),
and `auto` is unchanged. Re-opening the question needs a measurement on large-context sessions, where a handoff could
plausibly matter.
