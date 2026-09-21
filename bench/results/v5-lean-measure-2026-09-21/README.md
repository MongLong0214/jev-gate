# Lean efficacy measurement — attempted 2026-09-21, **no result**

Three runs were started and none produced an efficacy number. This file records why, because the failures are the
findings. **There is no lean token, cost, quality or time result. Nothing here supports any claim about savings.**

Authorized ceiling USD 25 (`~/jev-gate-runs/lean-host-1/AUTHORIZATION.md`). Spent **≈ $7.2**, stopped on request.

## The runs

| Run | Arms | Stopped after | Spend | Why |
|---|---|---|---|---|
| `lean-1` | 12 cells planned | 1 cell | $2.50 | every Jev request 400 |
| `lean-2` | 6 cells planned | 1 cell | $1.49 | every Jev request 400, again |
| `lean-3` | 6 cells planned | 1.5 cells | ~$1.50 | Jev answered, but the fixture forbids delegation |

Raw cells, traces and streams are under `~/jev-gate-runs/lean-{1,2,3}/`, outside the repository: they contain
session text. `lean-3/reports/report-1.md` is the rendered report of the partial run.

## Two implementation defects, neither findable offline

Every offline test used a fake HTTP double, which always returned 200. Both defects needed the real endpoint.

1. **Requests were bounded by bytes only.** ADR D6 says a byte cap is not proof of a token bound; the code capped at
   128 KiB and nothing else. Realistic sessions are Korean and code, so every packet overflowed and the feature
   could never fire in production. Fixed in `f8a70b0`.
2. **The first token estimate was calibrated on prose.** ASCII was charged at four characters per token. Real
   transcript content — `cat` output, JSON escaping, paths, punctuation — billed **1.7 bytes per token**: a 43 KB
   request the provider accepted cost 25,604 input tokens. A 63 KB request from the same source was refused, putting
   the binding limit near the documented 32K for state plus the longest question. Recalibrated to 1.5 ASCII
   characters per token with a 25,000 cap and verified against the transcript that produced the failure: 13 of 23
   groups packed at 31 KB, HTTP 200, provider billed 15,560 against an estimate of 20,875. Fixed in `42852ac`.

A third defect was in the reporting rather than the product: the run conclusion counted every HTTP bucket that was
not `null` as a failure, so a fully answered run read as "every one of jev_lean's 2 Jev attempts failed
(http_200:2)". Fixed in `749bfe2`.

## Why `lean-3` still measured nothing, and it is not a defect

With the token bound fixed, Jev answered both requests (200, 15,165 and 15,560 input tokens) and its relation
answers were usable — 11 of 13 groups marked omit on the second call. But `handoff_scope` came back **`forbidden`**
at 0.54 and 0.67, below the 0.8 action floor, so both turns recorded `scope_unusable` and stayed native.

That answer is correct. The priming turn of `wide-validators-primed-*` ends:

> 이 읽기는 네가 직접 해라. 서브에이전트나 다른 워커에게 넘기지 마라 — 파일 내용이 이 세션에 남아야 한다.
> *(Do this reading yourself. Do not hand it to a subagent or another worker — the file contents have to stay in
> this session.)*

That sentence is mandatory context, and it explicitly prohibits delegation. **Jev read the source correctly.**

This was nearly mis-handled. The `forbidden` answers sat at 0.52–0.67, the same band in which the legacy Gate A's
`forbids_delegation` question had once confused *method* restrictions with *delegation* restrictions
(`src/admission.ts`), so the first move was to assume the same defect and sharpen the criterion. An A/B of the old
and sharpened wording against the real source moved nothing — 0.66 to 0.67 — and only then was the mandatory text
actually read. **Tuning the wording would have made a correct judgement wrong.** No prompt change was made.

## What a real measurement needs

The depth fixtures cannot measure this feature: `jev_lean` can never dispatch in them, by construction. A run needs
new cases whose priming builds genuine removable history **without** prohibiting delegation. Editing the existing
cases is not an option — their prohibition is load-bearing for the depth work they were built for, and changing a
fixture to make a treatment fire is changing what is being measured.

Until such cases exist and are run, lean's efficacy is **unmeasured**, and the offline tests, the host observation
and these aborted runs must not be described as anything else.
