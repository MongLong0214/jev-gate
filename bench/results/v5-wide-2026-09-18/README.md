# Does routing ever pay? Two runs, and a fixture that did not test what it was built to test — 2026-09-18

Read `PREREGISTRATION.md` first: it was committed before this run and says what each outcome would mean.

Three measurements, in the order they were taken. The plugin was installed and driven through its own bench harness;
`node dist/cli.js doctor` passed first, including the host, the auth mode and the agent definitions.

## 1. Five jobs, two arms — no difference, because there was nothing to differ about

| arm | pass | total est $ | Jev est $ | runtime s |
|---|---|---|---|---|
| `jev_hierarchy` | 5/5 | 0.9468 | 0.000146 | 161.3 |
| `sonnet_native` | 5/5 | 0.9191 | 0 | 153.8 |

`jev_hierarchy` cost **3.0 % more** and ran **4.9 % slower**. The pre-registration set the bar at 20 % for a single
repetition, so this is **not distinguishable from noise** — and the mechanism explains why it cannot be anything else:
the report's own conclusion is **"no admission exposure — Gate A never admitted a prompt as orchestrated"**. Gate A
answered `direct` on all five, no worker was ever dispatched, and both arms therefore executed the identical shape. An
earlier run of the four original jobs came out the other way (−5.3 % cost, −14.6 % runtime, also 4/4 both arms), which
is the same non-result with the opposite sign.

Gate A is cheap in the way it was designed to be: **$0.000146 for all five gates**, 0.015 % of the Claude bill, at
558–637 ms each. Asking is not what costs anything.

## 2. The compound fixture did not discriminate, and that is a fault in the fixture

`wide-validators` was built for this run: twelve independent modules, one latent defect each, no coupling. The
pre-registration treated a `direct` answer here as "Gate A does not classify twelve independent outcomes as compound —
a negative result about Gate A's criterion."

**That reading is wrong, and the criterion says so in its own words.** `admission.ts` defines `direct` as including
"Many mechanical edits with no design decision are direct", and reserves `orchestrated` for "a compound deliverable
with **distinct outcomes and dependencies**". Twelve copies of the same one-line change are mechanical, have no
distinct outcomes, and have no dependencies between them. Gate A answering `direct` (confidence 0.49, so it fell back
to `direct` anyway) is the criterion working, not failing.

So the fixture is wide, not compound. It tested breadth where the gate discriminates on *kind*. The result stands as a
fact — `direct:1`, 5/5 pass in both arms, jev $0.3390 / 42 turns against native $0.3117 / 41 turns — but it does not
answer the question it was built for, and this directory should not be cited as though it did.

A fixture that would discriminate needs what the project's own README uses as its example: distinct deliverables with
dependencies between them — a state model, then a control surface that depends on it, then a display that depends on
both, then regression tests. That is unbuilt.

## 3. Gate A replayed on the operator's real prompts

The strongest measurement in this directory is in `GATE-A-ON-REAL-WORK.md`, because it needs no fixture at all: Gate A's
entire input is the prompt string, so the recorded sessions can be replayed through it exactly.

**0 of 110 genuine typed prompts would have been admitted as orchestrated.** Jev called 8.2 % of them compound but
never above 0.67 confidence against a 0.8 floor, and a third came back `needs_context` because the operator writes
continuations and Gate A is shown one string with no conversation around it. Removing the floor entirely still only
reaches 15.3 %.

An input-side A/B is in the same file's data: adding the preceding assistant turn to the state moved `needs_context`
from 17 to 13 of 68 and lifted the top `orchestrated` confidences from 0.60/0.58/0.46 to 0.83/0.73/0.65, at +380 input
tokens and no measurable latency change. Suggestive, and still only 1 of 68 over the floor. It is recorded as a
direction to test, not a change to make — Gate A sending only the raw request is a deliberate privacy property.

## Where that leaves the question

Nothing here shows routing costing anything: the gate is free and its judgments were defensible every time they were
examined. Nothing here shows routing *saving* anything either, and the reason is consistent across all three
measurements — **the orchestrated path is never taken.** Not on the bench jobs, not on the compound-shaped one, and not
on 110 prompts from real sessions.

Two things would change that, in this order:

1. **A fixture with distinct outcomes and dependencies**, which is what §2 says is missing. Until one exists, no run in
   this repository has put orchestration in front of work it was designed for.
2. **Deciding what Gate A is allowed to see.** §3 is the measurement that matters for real use, and it says the gate is
   blind for a structural reason rather than a calibration one. That is a product decision about privacy, not a
   threshold to move.

Artefacts: `report-single-file-jobs.md` (first run, four jobs), `/tmp`-free raw cells under
`~/jev-gate-runs/v5-dogfood-0918` and `~/jev-gate-runs/v5-wide-0918`, `gate-a-replay-*.json` (decisions, lengths and
confidences; the operator's prompt text is deliberately not published), and the harnesses that produced them.
