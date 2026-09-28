# Gate A cost model — results (2026-09-28)

Run as pre-registered in `PREREGISTRATION.md`, with `scripts/gate-a-cost-replay.mjs` against `dist/` of the 0.4.0
tree and `jev-1.13.0`. Numbers are in `summary.json`; the prompt text stays in `~/jev-gate-runs/` and is not here.

## What ran

100 prompts sampled (20 per actual-turn stratum, seed `20260928`), 100 answered, 0 failed. 50 calibration, 50
validation. The oracle is `cache_read − 11·D − turns·40,000`, the cost model itself (see the limit below).

## Calibration

| bin | prompts | median actual root turns | used |
|---|---|---|---|
| 0 | 2 | 5 | placeholder 0 (fewer than 3) |
| 1 | 20 | 10 | 10 |
| 2 | 18 | 5.5 | 10 (running maximum) |
| 3 | 9 | 8 | 10 (running maximum) |
| 4 | 1 | 4 | placeholder 60 (fewer than 3) |

Shipped map: `TOOL_CALL_TURNS = [0, 10, 10, 10, 60]`.

**Spearman correlation of Jev's score with the turns the prompt actually took: 0.075 over all 100, 0.048 on
calibration, 0.054 on validation.** Jev's read-off of the prompt text carries almost no information about how many
turns the turn will take. The medians do not rise with the bin; the map is flat through bins 1–3 because the running
maximum flattens it, and the top bin keeps its placeholder because Jev put only one prompt there.

## Validation (the pre-registered rule)

| | pre-registered (external_tools veto on) | shipped default (veto off, `guardAllowMcp: true`) — not pre-registered |
|---|---|---|
| admitted | 8 / 50 | 9 / 50 |
| precision (admitted with positive oracle saving) | 0.625 | 0.667 |
| recall (of 21 oracle-positive prompts) | 0.238 | 0.286 |
| net oracle saving over admitted | +30.4M tokens | +66.4M tokens |
| by reason | not_worth 36, external_tools 6, admitted 8 | not_worth 41, admitted 9 |

Against: native cost of the 50 validation prompts 885.1M; admit everything +513.6M; best possible +623.4M.

**Decision rule outcome:** net > 0 and precision ≥ 0.6 → ship the calibrated map. Shipped.

The second column is reported beside the first, not in place of it. The veto was made conditional after this run
showed it sending `gh` and shell work direct (14 of 100 prompts flagged); the justification is the design change (the
coordinator may now call MCP tools itself), not the better number.

## What this does and does not show

- The gate is net positive under the model on held-out prompts, and conservative: it recovers 5–11% of the saving
  the model says is available.
- The saving it leaves is not a calibration problem. With ρ ≈ 0.05, no map from Jev's text-only score to turns can
  pick the expensive prompts; most of the available saving is in the depth term, and the prompt text does not say
  which deep turns will run long ("진행해" at 400K carries work its text does not state).
- "Admit everything at depth" wins by 513.6M **under the model**, which prices delegation only by tokens. It says
  nothing about quality: the worker does not see the conversation, and a short prompt that leans on it may come
  back wrong or thin. Taking that lever needs a quality guard and a paid measurement, neither of which this run has.

## Limits

- The oracle is the cost model under test (`C = 11`, `d = 40,000`, both declared, not fitted). This run checks
  whether Jev's read-off picks the prompts the model favours, not whether the model is right.
- 50 validation prompts; precision 0.625 is 5 of 8. The confidence interval is wide.
- Real prompts from one owner's sessions, one week. Other workloads may differ.
- No paid end-to-end run was made for 0.4.0: the saving is the model's, not a measured bill.
