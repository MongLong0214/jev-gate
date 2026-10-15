/**
 * Router capability eval after dirien/jev-router docs/evaluation.md (Apache-2.0): labelled requests from
 * `bench/router/golden.json`, each asked as a fresh root turn with the same candidates, questions and selection the Router
 * uses (baseline opus/xhigh, frontier off, default floors). Every item is asked three ways: the role question with the
 * options cheapest first, the same question most capable first, and the v0.8.21 pair question as the control. Two
 * selection rules are read offline from each role answer: the shipped ordered cumulative mass, and dirien's per-role
 * accept bars. The test split is frozen by hash before any tuning; `run --split test` refuses a changed one.
 *
 * Live calls cost Jev tokens and need a key, so this is not part of `npm test`. Results describe this rubric, these
 * labels and the pinned Jev version only; thresholds need refitting when `jevModel` changes. Price weights are list
 * input prices relative to the baseline, an estimate that ignores token counts and effort.
 *
 * Usage:
 *   node dist/bench/router.js run    --split dev|test --out FILE [--concurrency 3] [--deadline-ms 30000] [--golden FILE]
 *   node dist/bench/router.js report --out FILE
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeCandidates } from '../claude-candidates.js';
import { DEFAULT_CONFIG } from '../config.js';
import { resolveApiKey } from '../credentials.js';
import { callJev } from '../jev.js';
import { providerPrice } from '../provider-prices.js';
import { validateChoice } from '../router-answers.js';
import { routingContext } from '../router-context.js';
import { offerPairs, offerRoute, pairReceipt, selectPair, type PairDecision, type PairOffer } from '../router-selection.js';

export const BASELINE = { model: 'claude-opus-5-5', effort: 'xhigh' } as const;
/** dirien's anthropic-only accept bars by role rank: a cheaper role needs more certainty before it is taken. */
export const ACCEPT = [0.85, 0.6, 0.3, 0.3] as const;
export const OPTIONS = ['mechanical', 'routine', 'complex', 'open_problem'] as const;
const ARMS = ['cheapest_first', 'capable_first', 'pair'] as const;
type Arm = (typeof ARMS)[number];

export interface Item { id: string; split: 'dev' | 'test'; label: string; effort: [string, string]; text: string; pair_of?: string; tags?: string[] }
export interface Route { model: string; rank: number; effort: string; reasons: { model: string; effort: string } }
export interface ArmRecord { ok: boolean; code?: string; duration_ms: number; jev_model?: string | null; usage?: unknown; answers?: Record<string, unknown>; top?: string | null; ordered: Route; accept?: Route }
export interface ItemRecord { id: string; split: string; label: string; effort_range: [string, string]; pair_of?: string; tags?: string[]; arms: Partial<Record<Arm, ArmRecord>> }

const defaultGolden = (): string => join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bench', 'router', 'golden.json');
export const testHash = (items: readonly Item[]): string => createHash('sha256').update(JSON.stringify(items.filter(i => i.split === 'test'))).digest('hex');

const candidates = () => claudeCandidates({ baseline: BASELINE.model, aliases: {}, allowFable: false });
const rankOf = (model: string): number => candidates().find(c => c.id === model)?.rank ?? -1;
const routeOf = (d: PairDecision): Route => {
  const model = d.patch.model ?? BASELINE.model;
  return { model, rank: rankOf(model), effort: d.patch.effort ?? BASELINE.effort, reasons: d.reasons };
};

/** The shipped role offer with its options in the requested order; `unclear` stays last either way. */
export const ordered = (offer: PairOffer, capableFirst: boolean): PairOffer => {
  const q = offer.questions['capability'];
  if (!q || q.type !== 'choice' || !offer.roles) return offer;
  const keys = offer.roles.map(r => r.option);
  const criteria = Object.fromEntries([...(capableFirst ? [...keys].reverse() : keys), 'unclear'].map(k => [k, q.criteria[k]!]));
  return { ...offer, questions: { ...offer.questions, capability: { ...q, criteria } } };
};

/** dirien `applyPolicy`: the argmax role, ties to the more capable; below its accept bar, the more capable of the top two. */
export const acceptPick = (offer: PairOffer, answers: Record<string, unknown>): string | null => {
  const q = offer.questions['capability'];
  const a = q?.type === 'choice' ? validateChoice(answers['capability'], Object.keys(q.criteria)) : null;
  if (!a || a.choice === 'unclear' || !offer.roles) return null;
  const p = (o: string): number => a.probabilities[o] ?? 0;
  const [top, second] = [...offer.roles].sort((x, y) => p(y.option) - p(x.option) || y.rank - x.rank);
  return second && p(top!.option) < ACCEPT[top!.rank]! && second.rank > top!.rank && p(second.option) > 0 ? second.option : top!.option;
};
/** The accept-bar role, then the same guards as production: the picked option is fed back as a certain answer. */
export const acceptDecision = (offer: PairOffer, answers: Record<string, unknown>): PairDecision => {
  const pick = acceptPick(offer, answers);
  const q = offer.questions['capability'];
  if (!pick || q?.type !== 'choice') return selectPair(offer, answers);
  return selectPair(offer, { ...answers, capability: { type: 'choice', choice: pick, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === pick ? 1 : 0])) } });
};

const ask = async (offer: PairOffer, text: string, apiKey: string, deadlineMs: number, rules: boolean): Promise<ArmRecord> => {
  const outcome = await callJev({ model: DEFAULT_CONFIG.jevModel, state: routingContext(text), questions: offer.questions }, { apiKey, deadlineMs });
  if (!outcome.ok || outcome.response.model !== DEFAULT_CONFIG.jevModel) {
    const native = routeOf(selectPair(offer, {}));
    return { ok: false, code: outcome.ok ? 'model_mismatch' : outcome.code, duration_ms: outcome.durationMs, ordered: native, ...(rules ? { accept: native } : {}) };
  }
  const answers = outcome.response.answers;
  const cap = offer.questions['capability'];
  const top = cap?.type === 'choice' ? validateChoice(answers['capability'], Object.keys(cap.criteria))?.choice ?? null : null;
  return { ok: true, duration_ms: outcome.durationMs, jev_model: outcome.response.model, usage: outcome.response.usage, answers: pairReceipt(offer, answers), top,
    ordered: routeOf(selectPair(offer, answers)), ...(rules ? { accept: routeOf(acceptDecision(offer, answers)) } : {}) };
};

export const wilsonUpper = (k: number, n: number, z = 1.96): number => {
  if (n === 0) return 1;
  const p = k / n;
  return (p + z * z / (2 * n) + z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
};
const quantile = (xs: number[], q: number): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]! : null;
};
const pct = (k: number, n: number): number => n ? Math.round(1000 * k / n) / 10 : 0;
const priceWeight = (model: string): number | null => {
  const base = providerPrice('claude', BASELINE.model, 0)?.input, own = providerPrice('claude', model, 0)?.input;
  return base && own !== undefined ? own / base : null;
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const inRange = (effort: string, [lo, hi]: [string, string]): boolean => EFFORTS.indexOf(effort) >= EFFORTS.indexOf(lo) && EFFORTS.indexOf(effort) <= EFFORTS.indexOf(hi);

/** exact / under / over against the label's rank, with the Wilson bound on under, confusion and estimated price. */
export const score = (rows: readonly { label: number; routed: number; effortOk?: boolean; price: number | null }[]) => {
  const n = rows.length, under = rows.filter(r => r.routed < r.label).length, exact = rows.filter(r => r.routed === r.label);
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of rows) { const row = confusion[OPTIONS[r.label]!] ??= {}; row[OPTIONS[r.routed] ?? 'unknown'] = (row[OPTIONS[r.routed] ?? 'unknown'] ?? 0) + 1; }
  const prices = rows.map(r => r.price).filter((p): p is number => p !== null);
  return { n, exact_pct: pct(exact.length, n), under_pct: pct(under, n), under_upper95_pct: Math.round(1000 * wilsonUpper(under, n)) / 10, over_pct: pct(rows.filter(r => r.routed > r.label).length, n),
    effort_in_range_pct_of_exact: pct(exact.filter(r => r.effortOk).length, exact.length), price_vs_baseline: prices.length ? Math.round(1000 * prices.reduce((a, b) => a + b, 0) / prices.length) / 1000 : null, confusion };
};

export const summarize = (records: readonly ItemRecord[]) => {
  const base = records.filter(r => !r.pair_of), probes = records.filter(r => r.pair_of);
  const labelRank = (r: ItemRecord): number => OPTIONS.indexOf(r.label as (typeof OPTIONS)[number]);
  const policy = (arm: Arm, rule: 'ordered' | 'accept') => {
    const rows = base.flatMap(r => { const a = r.arms[arm]; const route = a?.[rule]; return route ? [{ label: labelRank(r), routed: route.rank, effortOk: inRange(route.effort, r.effort_range), price: priceWeight(route.model) }] : []; });
    const byId = new Map(records.map(r => [r.id, r]));
    const downgraded = probes.filter(p => { const own = p.arms[arm]?.[rule], pair = byId.get(p.pair_of!)?.arms[arm]?.[rule]; return own && pair && own.rank < pair.rank; }).map(p => p.id);
    const belowLabel = probes.filter(p => (p.arms[arm]?.[rule]?.rank ?? Infinity) < labelRank(p)).map(p => p.id);
    return { ...score(rows), injection: { probes: probes.length, downgraded_vs_pair: downgraded, below_label: belowLabel } };
  };
  const out: Record<string, unknown> = {};
  for (const arm of ARMS) {
    const answered = base.filter(r => r.arms[arm]?.ok);
    const durations = records.flatMap(r => r.arms[arm]?.ok ? [r.arms[arm]!.duration_ms] : []);
    out[arm] = {
      calls: records.filter(r => r.arms[arm]).length, failed: records.filter(r => r.arms[arm] && !r.arms[arm]!.ok).map(r => `${r.id}:${r.arms[arm]!.code}`),
      latency_ms: { p50: quantile(durations, 0.5), p90: quantile(durations, 0.9) },
      ...(arm === 'pair' ? { ordered: policy(arm, 'ordered') } : { option_accuracy_pct: pct(answered.filter(r => r.arms[arm]!.top === r.label).length, answered.length), ordered: policy(arm, 'ordered'), accept: policy(arm, 'accept') }),
    };
  }
  const labels = base.map(labelRank);
  const constant = (rank: number, model: string) => score(labels.map(label => ({ label, routed: rank, price: priceWeight(model) })));
  const ranks = (arm: Arm, rule: 'ordered' | 'accept'): number[] => base.map(r => r.arms[arm]?.[rule]?.rank ?? 2);
  /** Random routing with the same role shares as a policy, independent of the label: expected rates, analytically. */
  const random = (routed: number[]) => {
    const share = (k: number) => routed.filter(x => x === k).length / routed.length, n = labels.length || 1;
    const sum = (f: (l: number, k: number) => boolean) => labels.reduce((acc, l) => acc + [0, 1, 2, 3].reduce((s, k) => s + (f(l, k) ? share(k) : 0), 0), 0) / n;
    return { exact_pct: Math.round(1000 * sum((l, k) => k === l)) / 10, under_pct: Math.round(1000 * sum((l, k) => k < l)) / 10, over_pct: Math.round(1000 * sum((l, k) => k > l)) / 10 };
  };
  out['controls'] = {
    always_baseline: constant(rankOf(BASELINE.model), BASELINE.model),
    always_cheapest: constant(0, candidates().find(c => c.rank === 0)!.id),
    same_share_random: Object.fromEntries(ARMS.flatMap(arm => (arm === 'pair' ? ['ordered'] as const : ['ordered', 'accept'] as const).map(rule => [`${arm}.${rule}`, random(ranks(arm, rule))]))),
  };
  out['jev_models'] = [...new Set(records.flatMap(r => Object.values(r.arms).map(a => a?.jev_model).filter(Boolean)))];
  out['price_note'] = 'list input price relative to the baseline; token counts and effort are not modelled';
  return out;
};

const flag = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const readRecords = (file: string): ItemRecord[] => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ItemRecord);

const run = async (argv: string[]): Promise<void> => {
  const split = flag(argv, '--split'), out = flag(argv, '--out');
  if ((split !== 'dev' && split !== 'test') || !out) throw new Error('run needs --split dev|test and --out FILE');
  if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
  const golden = JSON.parse(readFileSync(resolve(flag(argv, '--golden') ?? defaultGolden()), 'utf8')) as { frozen_test_sha256: string; items: Item[] };
  if (split === 'test' && golden.frozen_test_sha256 !== testHash(golden.items)) throw new Error('the test split changed since it was frozen');
  const apiKey = resolveApiKey(process.env);
  if (!apiKey) throw new Error('no Jev API key');
  const deadlineMs = Number(flag(argv, '--deadline-ms') ?? 30000), concurrency = Number(flag(argv, '--concurrency') ?? 3);
  const args = { baseline: { ...BASELINE }, candidates: candidates(), model: true, effort: true, upgrade: 0.8, downgrade: 0.6, scope: 'root' as const };
  const role = offerRoute(args), pair = offerPairs(args);
  if (!role?.roles || !pair) throw new Error('no role offer for the baseline');
  const offers: Record<Arm, PairOffer> = { cheapest_first: ordered(role, false), capable_first: ordered(role, true), pair };
  const items = golden.items.filter(i => i.split === split);
  const records: ItemRecord[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i]!;
      const record: ItemRecord = { id: item.id, split: item.split, label: item.label, effort_range: item.effort, ...(item.pair_of ? { pair_of: item.pair_of } : {}), ...(item.tags ? { tags: item.tags } : {}), arms: {} };
      for (const arm of ARMS) record.arms[arm] = await ask(offers[arm], item.text, apiKey, deadlineMs, arm !== 'pair');
      appendFileSync(out, JSON.stringify(record) + '\n');
      records.push(record);
      process.stderr.write(`${records.length}/${items.length} ${item.id}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  process.stdout.write(JSON.stringify({ split, items: items.length, jev_model: DEFAULT_CONFIG.jevModel, test_sha256: testHash(golden.items), ...summarize(records) }, null, 2) + '\n');
};

const isMainModule = (): boolean => typeof process.argv[1] === 'string' && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule()) {
  const argv = process.argv.slice(2);
  const main = argv[0] === 'run' ? run(argv.slice(1))
    : argv[0] === 'report' && flag(argv, '--out') ? Promise.resolve(void process.stdout.write(JSON.stringify(summarize(readRecords(flag(argv, '--out')!)), null, 2) + '\n'))
    : Promise.resolve(void (process.stdout.write('usage: node dist/bench/router.js run --split dev|test --out FILE [--concurrency 3] [--deadline-ms 30000] [--golden FILE]\n       node dist/bench/router.js report --out FILE\n'), process.exitCode = 2));
  main.catch((err: unknown) => { process.stderr.write(`bench router: ${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; });
}
