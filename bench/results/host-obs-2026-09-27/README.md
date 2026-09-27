# Installed-host observation, 2026-09-27 — results

Preregistered in [`PREREG.md`](PREREG.md) (commit `2280c24`) before any paid session. Host: Claude Code 2.1.283,
`--model opus --effort xhigh`, `-p`, clean environment, a fresh 4-file fixture repository per session. Raw data
(debug logs, stream JSON, probe and Router records, each session's repository) is in
`~/jev-gate-runs/host-obs-2026-09-27/`, not in the repository.

**Every row is one session.** They show whether a patch takes effect on the installed host. They are not a saving,
and none is claimed.

## Sessions

| id | arm | task | root effort: patch → step ran at | spawn model: patch → resolved | fixture tests | cost | wall |
|---|---|---|---|---|---|---|---|
| S1 | router | Explore | none (`low_confidence`) → xhigh | none (`low_confidence`) → Opus | — | $0.278 | 22.7 s |
| S1b | router | Explore | none (`low_confidence`) → xhigh | none (`low_confidence`) → Opus | — | $0.276 | 25.6 s |
| S1c | router | Explore | none (`low_confidence`) → xhigh | `sonnet` → `claude-sonnet-5` | — | $0.242 | 22.3 s |
| S2 | probe only | Explore | — → xhigh | — → Opus | — | $0.273 | 25.2 s |
| S3 | router | general-purpose | `medium` → (probe outside, not seen) | `sonnet` → `claude-sonnet-5` | 0/1, harness | $0.423 | 84.7 s |
| S3b | router | general-purpose | `medium` → **medium** | `sonnet` → `claude-sonnet-5` | 2/2 | $0.316 | 37.7 s |
| S4 | probe only | general-purpose | — → xhigh | — → Opus | 0/1, harness | $0.469 | 46.0 s |
| S4b | probe only | general-purpose | — → xhigh | — → Opus | 2/2 | $0.388 | 34.6 s |

Total spent: **$2.665** of the $10 authorised. S5 (Lean with the Router, #44B and #36) has not been run.

## What each session establishes

- **A spawn patch takes effect.** In S1c, S3 and S3b the Router asked for `sonnet` and the host reported
  `claude-sonnet-5` for the spawn and for every one of its steps. The Sonnet child cost $0.047 in S1c and $0.12 in
  S3b.
- **A root effort patch takes effect.** In S3b the probe sat inside the Router and saw both root steps at `medium`
  after the Router patched them from `xhigh`. The host ran those steps on the event the hook chain passed on. That is
  a boundary observation, not a check of the wire request.
- **The spawn's other fields are unchanged.** In S3b the event passed on carried `model: "sonnet"`. Its
  `permissionMode` (`acceptEdits`), type and provider matched what the host sent in the native S4b.
- **A spawn runs at its parent's effort.** Every Sonnet child step ran at `xhigh`, because `agent.spawn` has no
  effort field. The Router does not route a spawn's effort.
- **The tasks still passed.** The routed S3b and the native S4b both ended with the fixture's 2/2 tests passing.

## Deviations from the preregistration

- **Probe position.** The probe was outside the Router until S3, so it logged each event as the Router received it,
  before any patch. From S3b on it sat inside, where it sees what the Router passes to `next`. The spawn result
  (`spawn_out`, `spawn_result`) is the host's own report in both positions.
- **Router code.** Every run used a copy of the Router with `VERIFIED_HOST` set to 2.1.283, as preregistered.
  - S1 and S1b ran dev `6bd5a19`. Its floor on the top label's `confidence` held both spawns: in S1b the Explore
    lookup came back as `fast` with confidence 0.41.
  - S1c and the later sessions ran the working tree that became `64a2977`, which reads mass on each side. In S1c
    the same lookup was `fast 0.42, standard 0.57`, and 0.99 at or below `standard` moved it.
  - From S1b on, the copy also logged `obs_answers` (Jev's answer and usage). The host's debug log redacts any key
    containing `token` into a bare `[REDACTED]`, which left the Router's own usage lines unreadable. PR #49 renames
    those keys.
- **Harness failure.** The fixture's `node --test test/` fails on Node 22.23: the directory is resolved as a module.
  S3 and S4 therefore failed their tests in both arms. Both are kept and counted, and were rerun once with
  `node --test` as S3b and S4b.

## Cost and time

S1c against S2 is $0.242 against $0.273. S3b against S4b is $0.316 against $0.388, and 37.7 s against 34.6 s. The
S3b child took 7 steps and the S4b child 6. With one session per arm, these gaps are no larger than the gap between
two sessions of the same arm: S3 and S3b (both routed) cost $0.423 and $0.316, and S4 and S4b (both native) $0.469
and $0.388, although the harness failure in S3 and S4 changed what they did. **No saving is claimed.** A saving
needs the paired, repeated design in #45.

## The decision itself, offline (live Jev, no host)

Scripts and outputs are in `~/jev-gate-runs/host-obs-2026-09-27/issuance/`. The panel has 25 development tasks
(13 used while developing the questions, and 12 held-out tasks fixed before any run) plus 8 requests that should
stay put. Five of the 8 depend on earlier conversation and three pin a model or effort. Each request went once
through `createRouter` with an HTTP transport to Jev, from an Opus parent for spawns and an `xhigh` root:

| | labels (`64a2977`) | described levels (PR #49) |
|---|---|---|
| spawns moved, of 18 not deep | 12 | 14 |
| root turns moved, of 18 not deep | 6 | 13 |
| deep tasks lowered, of 7 | 1 (`xhigh` → `high`) | 0 |
| negatives moved, of 8 | 0 | 0 |

The four spawns left native under levels were held by `control`: `task_clear` was 0.68–0.82 against the 0.9 floor.
A call used about 870 input and 105 output units of Jev usage and returned in about 200 ms (median; the maximum was
276 ms).

## Reading "Jev Engineering: Stop Using LLMs for Every Decision"

Source: @0xwhrrari, 2026-09-21. It is a third party's article, and its vendor figures are unverified here.

| the article says | here |
|---|---|
| The LLM generates, Jev decides, code enforces | The Router asks Jev. `policy.ts` turns the distribution into a move, and pins, the allowlist and pair validity veto it |
| Choice / Score / Noul | Tier and effort became Score questions. `control` and `action_risk` stay Choice. A Noul split of `control` was probed and not adopted |
| The question is the contract: a key name teaches nothing, so the rule must be in the instructions and criteria | The levels describe work (`TIER_LEVELS`), and the level names never reach Jev |
| Flattening a probability into a label too early loses information | The move is read from probability mass on each side of the current level, not from the top label |
| Confidence zones and an escape hatch | `control` is the escape hatch. Moving down needs 0.9 plus `ordinary` risk, and moving up needs 0.8 |
| Receipts | Each decision logs `answers` (PR #49) |
| Shadow mode, then accuracy plotted against confidence, before automating a branch | **Not done.** The floors are policy numbers. The `answers` receipts are the input shadow mode needs |
| Cost per completed task | **Not measured.** It is what #45 would measure |
| 70–500 ms and $0.042 per million input units, with output not metered (vendor figures) | About 200 ms and 870 input units per call here. The price is not verified |
