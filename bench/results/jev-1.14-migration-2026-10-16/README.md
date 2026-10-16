# Moving the Jev pin from `jev-1.13.0` to `jev-1.14.0` — 2026-10-16

What was run before the pin moved, what it showed, and what was decided from it. Every number below is from one day,
one set of labels written by one person, and small samples; the limits are stated per item. Nothing here is a measured
product effect: a model that agrees with a label as often as before is not a saving, and a smaller packet is not a
token saving. Raw per-call records stay outside the repository; this directory keeps the aggregates and the scripts.

Price, context length and tokenizer are the same as `jev-1.13.0` (docs.typesafe.ai/models.md). `jev-latest` still points
to 1.13, so the versioned ID is pinned.

## A. Router effort on hard-but-short complex requests (dev split, 1.13 against 1.14)

The first 1.14 held-out run served two complex requests (`t-c04`, `t-c13`) at `medium` against a labelled `high` or
above. The dev split had no such request, so 12 were added (`d-c21` to `d-c32`, tag `hard_short`) and labelled before
any run; dev is now 84 requests. The frozen test split is unchanged (sha `6fa377c4…`). Three repeats, 252 answers per
model and policy, shipped policy and cheapest first, role order (`router-dev-x3.txt`, `scripts/router-dev-analyze.mjs`).

| Model, policy | Exact | Under | Over | Effort in range, of exact | Complex exact answers below the labelled effort |
| --- | --- | --- | --- | --- | --- |
| 1.13, shipped | 96.4% | 1.2% | 2.4% | 96.3% | 6 of 96 (6.3%) |
| 1.14, shipped | 97.6% | 1.2% | 1.2% | 96.7% | 5 of 96 (5.2%) |
| 1.13, cheapest first | 95.2% | 1.2% | 3.6% | 97.1% | 4 of 96 (4.2%) |
| 1.14, cheapest first | 96.4% | 1.2% | 2.4% | 96.7% | 5 of 96 (5.2%) |

The same three requests carry every effort miss on both models: `d-r16` (routine, served `high`, 3 of 3 on both),
`d-c21` (a public webhook field rename, `medium` in 3 of 3 on 1.13 and 2 of 3 on 1.14) and `d-c32` (a protobuf field
change, `medium` in 3 of 3 on both). Decision: no regression from 1.13 to 1.14 on the dev split, so no criteria change.
Whether `d-c21` and `d-c32` should be labelled `high` or both models are right is not settled by this data.

Held-out split, frozen, shipped policy, each run once per request (`router-test-*.json`):

| Run | Exact | Under (95% upper) | Over | Effort in range, of exact | Probes moved below their pair | Latency p50 / p90 |
| --- | --- | --- | --- | --- | --- | --- |
| 1.13 (earlier build) | 98.4% | 0% (5.7%) | 1.6% | 100% | 0 of 20 | 195 / 265 ms |
| 1.14, run 1 | 98.4% | 0% (5.7%) | 1.6% | 96.8% | 0 of 20 | 184 / 255 ms |
| 1.14, run 2 (final build) | 98.4% | 0% (5.7%) | 1.6% | 98.4% | 0 of 20 | 183 / 232 ms |

Run 1 had `t-c04` and `t-c13` below the labelled effort, run 2 had `t-c13`; 1.13 had none. Complex injection probes
below their labelled effort: run 1 `p02`, `p12`, `p13`; run 2 `p02`, `p13`; 1.13 `p09`, `p13`. The run-to-run difference
is one request. This is a held-out observation of 1 to 2 requests in 21 and is not something the dev split reproduces
on 1.14 more than on 1.13.

## B. Gate B worker and planner tiers (37 + 16 labelled items, 3 repeats)

`bench/v5/gate-b-set.json` (labels written before running, unchanged since) through `scripts/gate-b-calibration.mjs`,
the production request builders and deciders (`gate-b-jev-*.txt`). Identical input tokens on both versions (125,427
atomic, 146,073 composite, 26,460 planner).

| Shape | 1.13 | 1.14 |
| --- | --- | --- |
| Atomic worker (production), agrees with label | 108 of 111 (97.3%) | 109 of 111 (98.2%) |
| Composite five-way worker (not the shipped shape) | 94 of 111 | 93 of 111 |
| Planner | 45 of 48 | 45 of 48 |
| Atomic latency p50 / p90 | 180 / 237 ms | 173 / 234 ms |

By group on the atomic shape (agree of n): fast 30 of 30 on both; standard 27 of 30 on 1.13 and 28 of 30 on 1.14 (the
same item, `gb-s07`, README configuration docs, reads `fast` in 3 of 3 on 1.13 and 2 of 3 on 1.14); deep 30 of 30 on
both; negative 9 of 9, injection 6 of 6 and called-fast 6 of 6 on both. Planner: `gb-p11` reads `deep` against a
`frontier` label in 3 of 3 on both. The composite shape's misses differ by item (1.13: five `fast` items read standard
12 times, `gb-d07` standard 3 times, `gb-h02` fast twice; 1.14: three `fast` items read standard 6 times, `gb-d02`,
`gb-d04` and `gb-d08` standard 9 times, `gb-h01` fast 3 times); that shape is not the one in use. No change made.

**A first run of this section is withdrawn.** It read `it.prior` where the set's field is `prior_attempt`, so the seven
items that carry a prior attempt (`gb-d02`, `gb-d04`, `gb-d08`, `gb-h01`, `gb-n01`, `gb-n02`, `gb-n03`) were asked
without it. Review found it. That run gave atomic 98 of 111 (1.13) and 96 of 111 (1.14), and its finding that deep-labelled
retries read `standard` on 1.14 was a product of the missing field, not of the model. Both versions were run again in
full with the field passed and no label touched; the first files are kept as `gate-b-jev-*.run1-without-prior-attempt.txt`.

## C. Compact selection and Evidence relevance

`bench/compact/selection-eval.ts` (8 scenarios, 6 candidates each, from this repository's files, labels
required / related / unrelated set before running) and `bench/evidence/relevance-eval.mjs` (6 scenarios, 185 candidates,
labels relevant / unrelated / needs_context), 5 repeats each per run (`compact-selection-*.txt`,
`evidence-relevance-*.txt`). The table is the latest run of each.

| | 1.13 | 1.14 |
| --- | --- | --- |
| Compact: what the selector keeps against `required`, of 240 planned candidates | 212 (88.3%), fp 28, fn 0 | 221 (92.1%), fp 19, fn 0 |
| Compact: the model's four-way answers exact | 205 (85.4%) | 213 (88.8%) |
| Compact: `no-dependency` scenario (nothing required), 5 repeats | a dependency named in 5 of 5 | none named in 4 of 5 (`recency_kept`); 1 refused as `invalid_answers`, local order kept |
| Compact: latency p50 / p90 | 184 / 265 ms | 176 / 253 ms |
| Evidence: three-way exact, of 185 | 163 (88.1%) | 165 (89.2%) |
| Evidence: relevant ordered first at the 0.8 floor | 27 of 50 | 24 of 50 |
| Evidence: relevant folded (hides evidence) | 0 | 0 |
| Evidence: unrelated folded at the 0.9 floor | 95 of 110 | 90 of 110 |
| Evidence: latency p50 / p90 | 195 / 257 ms | 183 / 229 ms |

Runs so far, same scenarios and labels. Compact, required against not: run 1 212 of 240 on 1.13 and 221 on 1.14; run 2
214 and 220 (`*.run2-raw-answer-scoring.txt`); run 3 above, 212 and 221. Evidence three-way exact: run 1 163 and 162
(`*.run1.txt`), run 2 163 and 165. Every Compact false positive is a `related` candidate (cap constants, a tier default
line, a price table): the label is stricter than either model. An answer set that ties two answers at 0.49 is refused by
`validateChoice` by design and falls back to the local order; it occurred once in four of the six Compact runs (three per
version). Over the three runs Compact required-against-not was 212, 214 and 212 on 1.13 and 221, 220 and 221 on 1.14: 1.14 is 6 to
9 candidates higher in every run on these 8 small scenarios (the first two runs scored the raw answers, the third the
selector's result), which does not establish a general accuracy gain. Evidence was 163 and 163 on 1.13 and 162 and 165
on 1.14, which overlap. No change made.

Scoring note: runs 1 and 2 of Compact scored the model's raw answer per candidate, so a batch the selector refused still
counted and a candidate without an answer dropped out of the denominator (found in review). Run 3 scores the selector's
own `priorities` over every planned candidate (a refused batch keeps nothing); the raw-answer lines are still printed,
separately. Evidence scores the selector's validated reading and says how many candidates were unjudged (0 in every
run). Token totals in the three scripts are printed as a lower bound with the count of calls without a usage reading.

## D. Compressed request bodies

The Router and Compact mods cannot send compressed bodies: the host's `$.http.fetch` takes `HttpInit.body` as text and
has no binary type, so only `callJev` (Gate A and B, the Codex Router, Evidence, the bench) could. The API accepts
`content-encoding: gzip` and `zstd` (the 32 MiB limit applies to compressed and decompressed bodies; `br` returns 415).

Bodies built by the production request builders: Gate A 29, Gate B atomic 37, Router 30, Compact 8 and Evidence 6
requests (median 3.7 to 12 KB per site), gzip compresses to 21 to 43% and zstd to about the same. Latency:
`scripts/compression-measure.mjs`, 200 requests per encoding, per site and per mode, in a random order inside each pair, client compression time
included, 9,000 requests, all 200 with a valid answer (`compression-latency.txt`). Modes: a new TLS connection per
request (a hook process), one reused connection, and 8 concurrent.

Median latency difference against plain, paired for the sequential modes (95% bootstrap interval), in ms:

| Site | Body plain, gzip B | fresh gzip | fresh zstd | reuse gzip | reuse zstd | 8 concurrent gzip (unpaired) |
| --- | --- | --- | --- | --- | --- | --- |
| Gate A | 5,761 → 2,479 | −2.7 [−6.2, −0.8] | −2.0 [−5.4, 0.8] | −0.6 [−2.7, 0.6] | 0.0 [−2.9, 2.3] | −2.1 [−6.1, 1.0] |
| Gate B | 3,639 → 1,380 | 2.5 [−1.5, 5.6] | 0.0 [−2.8, 1.8] | −2.1 [−4.2, 0.2] | −0.9 [−5.8, 1.4] | −3.5 [−6.6, 0.1] |
| Router | 12,041 → 2,842 | −1.7 [−5.4, 1.3] | −2.4 [−10.4, 0.4] | −2.9 [−5.4, −1.6] | −0.4 [−4.3, 2.8] | −1.2 [−4.3, 1.8] |
| Evidence | 10,137 → 2,129 | −2.2 [−5.9, 1.6] | −2.0 [−6.2, 3.0] | −2.5 [−3.4, −0.4] | −1.5 [−2.4, 0.5] | −3.2 [−5.2, −0.9] |
| Compact | 6,736 → 1,767 | −1.3 [−4.4, 1.1] | −0.4 [−3.6, 2.8] | −1.1 [−2.3, 0.5] | −1.5 [−3.6, 0.1] | 0.0 [−2.0, 1.6] |

Pooled over the sequential modes of all sites (n = 2,000 pairs each): gzip −1.6 ms and zstd −1.2 ms at the median, on
requests that take 170 to 210 ms. Client compression costs 0.1 to 0.3 ms at the median and was 66 ms once. Decision:
not implemented anywhere. The gain is about 1% of the call and mostly inside the interval; bodies of this size are about
one initial TCP congestion window (about 14 KB), which is the likely reason fewer bytes do not shorten the round trip.
Two of the five call sites cannot do it at all, `zstd` would need a feature test (`zlib.zstdCompressSync` exists from Node 22.15 and the engines floor is
`>=22`), about 45 tests parse `init.body` as JSON, and the Codex proxy already handles both encodings on its own path.
The Gate B bodies of the corpus are smaller than production (3.7 KB against about 10.5 KB observed in traces); the
Router and Evidence rows are at the production size, and none of them showed a gain. The corpus script had the same
`prior` against `prior_attempt` field-name defect as section B, so seven Gate B bodies lacked their prior attempt when
the latency was measured; with the field passed the corpus median goes from 3,671 to 3,705 bytes and the maximum stays
3,990, so the Gate B row was not measured again.

## E. The long-context header

`TypeSafe-Danger-Zone-Long-Context: true` raises the per-request limit from 64k to 262k tokens and the per-question
limit from 32k to 262k, on 1.13 and 1.14 at the same price per token; the docs say it is slower and less accurate than
staying within the defaults.

**Where the provider refuses without it** (`context-exceeded-probe.txt`, production `callJev`, no header): 60,000
characters (19,064 tokens) to 110,000 characters (32,993 tokens) answered; 120,000 characters (about 36k tokens by the same
characters per token) answered `context_exceeded` / 400, twice. So the provider's line lies between 33.0k and about 36k
tokens, and the new error code fires on the live API.

**Call sites and local caps.** `callJev` refuses above 128 KiB of request (`request_too_large`, original call kept);
Gate A in `src/hook.ts` likewise; the Codex Router and the Router and Compact mods cap the calibrated token estimate at
25,000 (`input_too_large`); Compact selection drops the newest candidates until the request fits; Evidence trims a page
to the same cap (`remote_budget`). The estimator over-counts 2.2 to 2.5 times (63,520 characters of this repository's
source estimate 42,799 against 19,713 billed tokens, the fixed Gate A question included; a Gate A prompt of 4,985 bytes
estimates about 3,300 against 1,352), so the 25,000 cap sits near 10,000 to 11,000 real tokens, a third of the
provider's line.

**How often a request would need the header** (`scripts/evidence-cap-frequency.mjs` for Evidence, the rest from local
records; aggregates only):

- Three days of local traces (Codex 805 Router calls and 2,157 responses, 32 Gate A, 30 Gate B, 22 Evidence, 40 Compact;
  Claude 25): 0 occurrences of `input_too_large`, `request_too_large` or `remote_budget`.
- 30 days of typed prompts in Claude Code transcripts, 3,223 of them: bytes p50 182, p90 4,046, p99 28,321, max 56,401;
  estimated tokens p50 82, p90 2,391, p99 17,441, max 35,306. Gate A's byte cap: 0 of 3,223 would exceed. The Router's
  estimated-token cap: 8 of 3,223 (0.25%) with no earlier turns, at most about 82 (2.5%) counting the largest prior turns.
  None of them is near the provider's line: the largest, 56 KB, is about 15,000 to 17,000 tokens at 3.3 to 3.7 bytes per
  token.
- Evidence on this repository, 90 goals through the real service with a fake Jev: 73 calls were trimmed by the request
  cap and 160 of 1,440 page candidates went unjudged; request bytes p50 34,290, max 38,236, estimated tokens p50 22,743,
  max 24,959 against the cap of 25,000. That is the page packing limit working as designed (a page is split over about two
  requests), at about 10,000 real tokens, far from the provider limit; the header would not change it.

**Accuracy and latency with the header** (`scripts/long-context-needle.mjs`, `long-context.txt`; real token counts from
`usage.input_tokens`; this repository's source as filler; 3 repetitions per cell; the header is on above 30k tokens and
both ways at 20k).

| State (real tokens) | Latency p50 / p90 | Router top choice against label, of 54 (start, middle, end of the paste) | Gate A `forbids_delegation` ≥ 0.6, buried needle, of 12 |
| --- | --- | --- | --- |
| 2.5k (no paste, no header) | 180 / 248 ms | 18 of 18 | — |
| 20k, no header | 269 / 312 ms | 54 of 54 | 3 of 12 |
| 20k, header | 267 / 272 ms | 54 of 54 | 3 of 12 |
| 40k, header | 423 / 502 ms | 51 of 54 | 4 of 12 |
| 80k, header | 848 / 942 ms | 53 of 54 | 6 of 12 |
| 150k, header | 1,850 / 1,886 ms | 54 of 54 | 6 of 12 |

Controls (no needle) stayed below 0.6 in all 18 observations (six conditions of 3; condition means 0.22 to 0.33,
highest single value 0.46 at 150k). The needle is a labelled no-delegation prompt from `bench/v5/admission-set.json` buried at 10, 50 and 90% of the paste or placed last; it reads
0.68 to 0.75 alone and 0.51 to 0.64 inside a 4,000-character paste already, so this probe is weak and the Gate A column
shows no loss with length, not that length is harmless. The Router column shows no loss up to 150k on these 6 labelled
requests, but the three misses at 40k are in the middle position.

**Decision: not implemented.** Latency grows with the state (about +250 ms at 40k, +670 ms at 80k, +1.7 s at 150k over
a 180 ms call), the provider calls the mode less accurate, and in 3,223 real prompts and three days of traces no request
came near the provider's own limit; the local caps that do trigger sit at a third of it and are packing limits that the
header does not lift. Adding a `longContext` option, a deadline and a fallback to every call site would cost code and a
documented "danger zone" header for no observed request. Revisit if a trace records `context_exceeded`.

## F. Answers that carry fields the product does not read

Every validator that reads a Jev reply was checked for what it does with a field it does not know (a per-question
`legend`, a `rationale`, a `confidence` beside a `noul`): Gate A and Gate B atomic deciders, the Router's choice reader,
the Compact selector and the Evidence selector. None of them rejects an answer for an extra field, and none reads one;
a test per site now pins that (`tests/admission-atomic.test.ts`, `tests/allocation-atomic.test.ts`,
`tests/compact/selection.test.ts`, `tests/evidence/selector.test.ts`, `tests/jev.test.ts`; the Router's own choice reader, `src/router-answers.ts`, already had one in `tests/router/policy.test.ts`), so a later Jev version that
adds a field cannot void a batch or change a decision. No code change was needed.

## G. Codex path

`plugins/codex/dist` and `plugins/evidence/dist` are build outputs (`.gitignore: dist/`); after `npm run build` they
contain `jev-1.14.0` and the `context_exceeded` code and no 1.13 pin other than the price table. `npm run
test:codex:runtime` (real Codex CLI 0.162.1, fake local model, isolated home): 32 of 32 pass. On a clean checkout of
v0.8.23 the same command failed 8 of 32 before any change here, for two reasons that were not the pin: three tests read
the `.retention` marker the trace writer keeps (added with 3-day records) as JSON, and the fake Jev in five scenarios
answered a `model` question that the Codex Router has asked as `capability` since v0.8.22. Both were fixed in
`tests/codex/runtime.test.ts`: the three reads filter `.json` like the other reads in that file, and the fake answers
`capability: mechanical` where the scenario expected the cheaper model. `gpt-6.1-sol` is untouched.

## Files

- `scripts/router-dev-analyze.mjs` — effort and route breakdown of `npm run bench:router -- run` outputs.
- `scripts/compression-corpus.mjs`, `compression-capture-preload.mjs`, `compression-measure.mjs`,
  `compression-analyze.mjs` — body corpus, latency measurement and its analysis. The corpus is written next to the
  script as `corpus.json`: Gate A, Gate B and Router bodies from `compression-corpus.mjs`, Compact and Evidence bodies by
  running `bench/compact/selection-eval.ts` and `bench/evidence/relevance-eval.mjs` once under
  `JEV_CAPTURE_FILE=… JEV_CAPTURE_SITE=… node --import ./compression-capture-preload.mjs`. It is not committed.
- `scripts/long-context-needle.mjs`, `long-context-analyze.mjs`, `context-exceeded-probe.mjs`,
  `evidence-cap-frequency.mjs` — the long-context checks.
- `bench/compact/selection-eval.ts`, `bench/evidence/relevance-eval.mjs`, `scripts/gate-b-calibration.mjs` and
  `bench/v5/gate-b-set.json` are in their usual places.

The three runs that need a key: `TYPESAFE_API_KEY=… node scripts/gate-b-calibration.mjs --model jev-1.13.0 --repeats 3`,
`… node bench/compact/selection-eval.ts --model jev-1.13.0 --repeats 5`, `… node bench/evidence/relevance-eval.mjs
--model jev-1.13.0 --repeats 5`; the same without `--model` runs the pinned version.
