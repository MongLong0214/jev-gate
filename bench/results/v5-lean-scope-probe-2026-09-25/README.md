# Lean `handoff_scope` probe on the depth fixtures' own text — 2026-09-25

A check of one claim, not a measurement of lean. `v5-lean-measure-2026-09-21` concluded that `forbidden` was the
correct answer on the depth fixtures and that `jev_lean` "can never dispatch in them, by construction". This probe
reads the actual original inputs and asks the production question about them.

**n = 3 per case, one model (`jev-1.13.0`), one day, a reduced source.** Not a calibration, not an accuracy, not a
dispatch rate. 15 calls, 29,661 input tokens billed, ≈ $0.0012. No Claude session was run.

## What the original inputs say

`wide-validators-primed-13` (`bench/cases-depth.json`) has two priming turns and then the task:

1. Read `reference/note-01.md` … `note-13.md`, one `cat` per call; `src/` 는 아직 건드리지 마라.
   **이 읽기는 네가 직접 해라. 서브에이전트나 다른 워커에게 넘기지 마라 — 파일 내용이 이 세션에 남아야 한다.**
2. 앞의 파일을 모두 읽었으면 준비됨 이라고만 답하고 멈춰라.
3. The request: fix the empty-array check in twelve validator modules, add tests, run `npm test`. It restates no
   restriction.

The ban names **this reading** (이 읽기), a task that finished with 준비됨. Its stated purpose — the contents must stay
in this session — says why the reading was not delegated; it does not say the later task may not be. The notes
themselves open "It records what was looked at; it sets no rules." So the text is a completed earlier task's local
restriction whose reach to the later task is at most arguable. It is not an explicit session-wide ban, and nothing in
the inputs makes `forbidden` *the* correct answer. (The lean-3 run's own Jev requests and answers were under
`~/jev-gate-runs/lean-3/` and are no longer on this machine, so its exact state could not be re-read.)

## Probe

`probe.mjs` builds each source by hand, packs it with the production `buildLeanRequest` — the current criteria, which
since `eac9bb9` say a restriction on a different, earlier task does not cover this request and that quoted tool text
is not a user restriction — and calls the endpoint. Every case uses the real priming and task text; the reading is
three synthetic `cat` groups rather than thirteen real ones.

| Case | What differs | `handoff_scope` (3 runs) | P(forbidden) | P(self_contained) | confidence |
|---|---|---|---|---|---|
| `depth_original` | nothing — the fixture's text | self_contained ×3 | 0.34–0.40 | 0.54–0.58 | 0.38–0.44 |
| `control_no_ban` | the two ban sentences removed | self_contained ×3 | 0.01–0.02 | 0.85–0.88 | 0.79–0.84 |
| `current_task_ban` | control + "이 작업은 네가 직접 해라. …넘기지 마라." appended **to the request** | forbidden ×2, self_contained ×1 | 0.45–0.59 | 0.39–0.52 | 0.35–0.45 |
| `session_wide_ban` | control + an earlier "이 세션이 끝날 때까지 어떤 작업도 …넘기지 마라." | forbidden ×3 | 0.58–0.60 | 0.37–0.38 | 0.45–0.47 |
| `quoted_tool_content` | control + a required `Read` result whose file text holds the ban | self_contained ×3 | 0.36–0.44 | 0.50–0.57 | 0.33–0.43 |

`work_shape` was `sustained_task` at confidence 1 in all 15.

## What it shows

- **The depth fixtures are not blocked by a valid global ban.** On their own text Jev now leans `self_contained`,
  below the 0.8 action floor, so lean stays native as `scope_unusable` — the conservative outcome for scope it cannot
  establish. They still cannot exercise a handoff in practice, but because the scope is ambiguous, not because the
  inputs forbid it.
- **Any ban lifts P(forbidden) from ≈ 0.01 to 0.34–0.60, but the question does not rank the four kinds.** An explicit
  ban in the current request — the plainest case there is — reached only 0.45–0.59 and lost to `self_contained` once.
  It is no higher than the session-wide ban and overlaps the scoped and the quoted ones.
- **Every ban variant stayed native through the 0.8 confidence floor (`scope_unusable`), never through a confident
  `forbidden` (`scope_forbidden`).** The highest confidence on any ban case was 0.47, and a `self_contained` answer
  at 0.8 would dispatch. That gap is what lean's respect for an explicit prohibition rests on, observed three times
  per case on one phrasing each; nothing here bounds how a different phrasing, a longer source or English text would
  score.
- The no-ban control straddles the floor (0.79, 0.82, 0.84), so even a fixture with no restriction would dispatch on
  only some turns.

## What it does not show

No handoff happened and none was attempted. Whether the root session or the executor would honour an explicit ban
after a wrongly confident `self_contained` is not observed here. Korean text only; no calibration of the confidence
scale exists.

Rewording the criteria to move these numbers was rejected. Raising `forbidden` on the explicit ban, or lowering it
on the depth fixture's text, by editing the criteria is the tuning the 2026-09-21 report warned against. A real fix
for weak discrimination needs its own measured design (#45).
