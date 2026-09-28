# Gate A cost model — calibration and validation (pre-registered 2026-09-28, before any Jev answer was read)

## Why

Owner review of real use (2026-09-28): the atomic Gate A vetoed on `answer_only`, which says nothing about cost (a
26-call analysis would have run direct and cost 7.9M tokens against 3.24M delegated), and its `size ≥ 1` floor let
almost anything through the veto. 0.4.0 replaces both with one question — *how many tool calls would this take* —
and a price: delegate iff `(N − C)·D − N·d > 0`, where `D` is the depth the session carries, `N` the root turns the
request would take natively, `C` the root turns the coordinator still takes (11, the low end of the jev_single
bench's 11–17) and `d` the tokens one worker turn reads (40,000, declared).

`N` is not asked of Jev directly; Jev answers a five-bin read-off (`tool_calls`, 0–4), and code maps the bin to
turns. This run sets that map and then checks the decisions it produces on prompts it was not set on.

## Data

`~/jev-gate-runs/gate-a-cost-2026-09-28/rows-all.json`: 636 real prompts from the owner's transcripts typed at depth
≥ 50K, each with the depth it was typed at, the root turns and tool calls it actually took, and the cache read it
actually cost. It holds real prompt text and is never committed or published; this directory holds numbers only.

## Procedure (fixed before the run)

1. **Sample.** Stratify by actual root turns into `[0,1]`, `[2,4]`, `[5,12]`, `[13,35]`, `[36,∞)` and draw up to 20
   per stratum with a seeded shuffle (seed `20260928`). Alternate rows within each stratum into a calibration and a
   validation half.
2. **Ask.** One `buildAtomicAdmissionRequest` call per prompt against `jev-1.13.0`, from `dist/`, as the hook sends
   it. No retries; a failed call is reported and left out.
3. **Calibrate.** For each bin `k`, `TOOL_CALL_TURNS[k]` = the median actual root turns of calibration prompts whose
   answer rounds to `k`. A bin with fewer than 3 prompts keeps the declared placeholder (`[0, 2, 7, 18, 60]`). The
   result is made non-decreasing (running maximum). Nothing else is fitted: `C` and `d` stay as declared.
4. **Validate.** On the validation half, decide each prompt with the calibrated map at its own depth, with the
   shipped vetoes. The oracle saving of a prompt is what it actually cost minus what delegating would have cost:
   `cache_read − C·D − turns·d`.

## What is reported

- Per-bin counts, medians and the calibrated map; Spearman correlation of score against actual turns (both halves).
- On validation: admitted count, the share of admitted prompts with a positive oracle saving (precision), the share
  of oracle-positive prompts admitted (recall), and the net oracle saving summed over admitted prompts, against the
  same sum for "admit everything" and for "admit nothing" (0).

## Decision rule (fixed before the run)

- Net oracle saving over admitted validation prompts **> 0** and precision **≥ 0.6**: ship the calibrated map.
- Net saving > 0 with precision < 0.6: ship the calibrated map and state the precision as measured.
- Net saving ≤ 0: admission is restricted to the top bin (score ≥ 3.5) and the shortfall is reported as a limit.
  Changing `C` or `d` after seeing the result is not an allowed fix: that would fit them to this run.

## Limits known in advance

- The oracle charges delegation `C·D + turns·d`, the same model under test; it measures whether Jev's read-off picks
  the prompts where the model says delegation pays, not whether the model itself is right. The model's shape rests on
  the jev_single bench and the 631-prompt per-turn cache-read measurement, not on this run.
- Jev sees only the prompt text. A short prompt deep in a session ("진행해") carries work its text does not state.
