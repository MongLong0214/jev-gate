# Decision — flip Gate A to `atomic` by default, leave Gate B at `composite` — 2026-09-19

Written after the measurements of 2026-09-19 and before the change, so the reasoning is on record separately from the
numbers that prompted it.

## Gate A: `composite` → `atomic`

**The shipped default does nothing.** The composite question admitted **0 of 61** real prompts in the offline replay
even when depth was supplied. A gate that never admits is not a conservative default; it is a product that does not
run. Every cost result in this repository was obtained either by forcing admission or by setting this key by hand.

**The atomic path admits, and what it admits is cheaper.** Offline it admits 41 of 65 real prompts and decides both
ground-truth cases correctly. End to end at ~376K it admitted twice, both passing, and the job turn cost **−59 % to
−69 %** against native depending on the plan size the planner returned
(`v5-gate-a-live-2026-09-19/`, `v5-plan-variance-2026-09-19/`).

**Refusing is mechanically free, though not measurably so.** Below the floor the gate sends **no request at all** —
`attempted: false` on every prompt, zero workers, zero orchestration, observed in four cells. What the refused turn
adds is one hook process and 706 characters of guidance text, about 200 tokens against a 180,000-token session. The
shallow measurement could not confirm this within 10 %, because that bench condition has a 27 % native spread; the
mechanism is visible in the code and the trace, and no cost claim is made from those cells.

**One of the conditions written for this flip was never met, and the flip happens anyway.** The condition asked that
`jev_hierarchy` on a shallow case cost the same as `sonnet_native` within noise. It cannot be shown on this bench:
the noise is larger than the claim. Treating an unmeasurable condition as a permanent veto would leave a gate that
never admits as the shipped behaviour, which is the worse error. The condition is recorded as unmet rather than
quietly dropped.

## Gate B stays `composite`

The atomic route question was measured end to end **once** (−50.5 % deep, +92.5 % shallow), and the depth floor now
refuses the shallow condition that produced the harm. That is an argument for trying it, not evidence for shipping
it. Every cost figure quoted above was obtained with `routeQuestionShape: composite`, so flipping it would change the
configuration those numbers describe. It stays until it has its own two-repetition result at depth.

## What this changes for someone who installs the plugin

With `mode: auto` and no config file, a prompt now reaches Gate A's read-off questions instead of the four-way choice.
Deep sessions with substantial work get orchestrated; shallow sessions, answer-only turns and the first prompt of any
session stay direct, the last of these without a request at all.

## What would reverse this

- A real session where an admitted job costs more than it would have direct, at depth, with a plan at or under the
  ceiling.
- Evidence that the refusal path costs materially more than native once a bench can resolve it.
- `delegationDepthFloor` turning out to be far from the crossing point in either direction.
