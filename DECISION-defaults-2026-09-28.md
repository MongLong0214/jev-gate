# Decision — 0.4.0 defaults — 2026-09-28

Written with the change, after the owner's review of real use the same day. The owner decided the first two; the
rest were delegated ("나머지는 너가 모두 자율판단해서 진행해") and are recorded here with their reasons.

## Decided by the owner

- **Keep Gate B and make it act** ("Gate B 끄지말고 기능을 더 극대화하자"). `routeQuestionShape` → `atomic`. The composite
  answer never cleared its 0.8 floor in use (0.78, 0.35), so the gate was paid for on every dispatch and never changed
  one. The atomic shape has no floor and never picks frontier. The Router skips jev-gate dispatches (`gate_routed`);
  without that, the Router's own assessment would replace Gate B's on every dispatch it made.
- **Single first.** `admittedShape` → `auto`: single unless Gate A reads separate outcomes (`parallel_outcomes`) or a
  whole project (`size = 4`). Evidence: `DECISION-admitted-shape-2026-09-19.md`.

## Decided under delegation

- **Price, not kind.** Gate A delegates on `(turns − C)·D − turns·d > 0`, with `C = 11` (the low end of the jev_single
  bench's 11–17 coordinator turns) and `d = 40,000` (declared). The map from Jev's score to turns was calibrated and
  validated under a pre-registration written before any answer was read (`bench/results/v5-gate-a-cost-2026-09-28/`).
  It met the pre-registered rule, so it ships.
- **`external_tools` vetoes only when `guardAllowMcp` is off.** This is not pre-registered. The reason is the design
  change, not the number: once the coordinator may call MCP tools itself, a connector step no longer blocks
  delegation. The run showed the veto also flagging `gh` and shell work (14 of 100). Both numbers are published side by
  side in RESULTS.md.
- **Verification refuses only on contradiction.** A reported pass whose last observed run failed is refused. Refusing
  an unobserved or stale check too was ruled out: the transcript cannot see every way a check can be run, so it would
  refuse correct work. Those are recorded and refuse nothing.

## Not decided here

- **Admit-by-depth.** Under the model it would save 513.6M of 885.1M native, against the gate's 30–66M. It was
  considered and decided against for this release, because the model prices tokens only. A worker does not see the
  conversation, and a short prompt that leans on the conversation may come back wrong. Taking it needs a quality
  guard and a paid measurement, which is the owner's call.
