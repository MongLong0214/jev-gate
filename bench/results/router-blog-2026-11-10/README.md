# Router rubric after Anthropic's model selection guidance — 2026-11-10

Source: [Which Claude model should you build with?](https://claude.dev/blog/which-claude-model-should-you-build-with/).
Jev `jev-1.14.0`, `node dist/bench/router.js run`, baseline Opus 5.5 / `xhigh`, default floors, one call per item and
policy. New items (tag `blog_2026_11`) were written and labelled before any run. Raw outputs stay outside the repo.

## Wording changes (`src/router-selection.ts`, `src/claude-candidates.ts`)

- mechanical: classifying, tagging or extracting fields from supplied records (shared with Codex).
- complex: migrating to a new framework or breaking major version, even with an upgrade guide (shared with Codex).
- Claude frontier option `open_ended` replaces `open_problem` for Fable: major refactors or migrations across a large
  codebase, large-system architecture, leading many workers, long unattended runs, in-depth research, scientific or
  quantitative analysis, novel algorithms or proofs. Everyday hard engineering stays on Opus. Codex keeps `open_problem`.

## Shipped policy (most capable first)

| split | n | old wording | new wording |
|---|---|---|---|
| dev (Fable off) | 94 | 94.7% exact, 1.1% under, 4.3% over | 97.9% exact, 0% under, 2.1% over |
| frozen test (Fable off) | 64 + 20 probes | 98.4%, 0% under, 0/20 probes moved | 98.4%, 0% under, 0/20 probes moved |
| spawn (Fable off) | 17 | 17/17 | 17/17 |
| frontier (Fable on) | 11 | 6/11 exact, 0/5 open-ended to Fable | 7/11 exact, 1/5 open-ended to Fable |

Old-wording misses among the new dev items: `d-m27`, `d-m28` (extraction) and `d-c35` (guided framework migration) to
Sonnet.

New wording with Fable on: test and spawn sent nothing to Fable; dev sent only `d-c20` (research-level, tagged
`frontier_capped`), and two other dev items moved within one run (`d-r18` kept the baseline on low confidence, `d-mm5`
one role under).

## Frontier split

`capability` read `open_ended` 0.85–0.99 on all five open-ended items and 0 on the four complex controls. Only `f-o05`
reached Fable (`high`). `f-o01`–`f-o04` stayed on Opus: the control question read `task_clear` 0.45–0.71 with the rest
on `needs_context`, and an upgrade needs `task_clear` at the 0.8 upgrade floor. That floor gates every upgrade, so it was
not changed. On the old wording none of the five reached Fable and `f-o05` went to Sonnet.

## Limits

One labeller, one run per split, five open-ended items. Agreement with labels is not evidence that Fable or a cheaper
model finishes the work, and the price column of the summary is list input price, not cost.
