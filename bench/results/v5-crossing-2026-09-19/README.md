# Where delegation starts paying, and why the floor stays at 300,000 — 2026-09-19

`delegationDepthFloor` shipped at 300,000 derived from two points. This run adds two more depths between them, and
then answers a different question than the one it was built for.

## Three depths

| depth at the job prompt | `sonnet_native` | delegated | difference | verdict |
|---|---|---|---|---|
| **~180K** | $1.4540 / $1.4336 | $1.1385 (4 tasks) / $1.4449 (3 tasks) | −10.5 % | **indistinguishable** — under the 15 % this bench can claim |
| **~281K** | $2.0558 / $2.6121 | $1.3293 (2 tasks) | **−43.0 %** | clearly cheaper, one valid delegated cell |
| **~376K** | mean $3.0887 (4 cells) | $0.9658 (2 tasks) / $1.2552 (3 tasks) | **−59 % to −69 %** | settled |

All listed cells passed their checks. One cell is excluded under pre-registration rule 1: `21-note` forced r1 reached
only 33,216 context because its priming turn read one of the twenty-one files and stopped — and it also failed its
checks. Its cause is recorded below.

**The crossing lies between 180K and 281K.** Native cost rises roughly with depth ($1.44 → $2.33 → $3.09 across
180K → 281K → 376K) while the delegated cost tracks plan size and barely moves with depth ($1.33 at 281K against
$0.97–$1.26 at 376K). That is the mechanism the whole design rests on, now visible in three points rather than
asserted from two.

## The floor stays at 300,000, and the reason is not precision

The honest measurement answer is that this bench cannot locate the crossing more tightly than "between 180K and
281K". The useful answer is that it does not need to. Against the 63 real prompts with their recorded depths:

| floor | prompts refused |
|---|---|
| 180,000 | 1 / 63 (2 %) |
| 250,000 | 3 / 63 (5 %) |
| **300,000** | **8 / 63 (13 %)** |
| 400,000 | 14 / 63 (22 %) |

p10 of real prompt depth is 296,514. Nine prompts in ten are admitted at any floor in this range, and in that region
the saving is 59–69 %. Lowering the floor from 300,000 to 180,000 would admit **7 more prompts, 11 % of the total**,
and the measured effect in exactly that band is −10.5 %, indistinguishable from noise.

So the conservative floor costs 11 % of prompts in exchange for certainty on the rest. It stays. This is a decision
about which errors to prefer, not a number fitted to a measurement — and pre-registration rule 4 said in advance that
this run would not move it.

## The invalid cell, and what it says about the forced arm

`21-note` forced r1: the priming turn read `reference/note-01.md`, answered, and stopped, leaving the session at
33,216 when the job prompt arrived. The same configuration primed correctly in both 13-note cells and in the other
21-note cell.

The forced arm orchestrates **every** prompt, priming included, so the priming turn receives coordinator guidance
("complete small self-contained work directly; do not delegate individual file reads") on top of a priming prompt
that now says the reading must be done by the session itself. That combination has produced two different failures
across today's runs — one cell delegating the reads to workers, one cell doing almost none of them. **Priming a
session inside the arm that forces orchestration is unreliable**, and a future depth study should prime in a mode
that leaves the priming turn alone.

## Not settled

- 281K has one valid delegated cell. The −43 % there is a direction with a plausible size, not a two-repetition
  result.
- Plan size still varies freely (2, 3, 4 across these cells), and at 180K it is what makes the two delegated cells
  differ by 27 %.
- Everything is one job on one fixture.
