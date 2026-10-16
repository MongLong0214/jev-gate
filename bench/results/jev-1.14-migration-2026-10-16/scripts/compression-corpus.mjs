import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const R = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const imp = (p) => import(R + '/dist/' + p);
const { buildAtomicAdmissionRequest } = await imp('admission.js');
const alloc = await imp('allocation.js');
const { DEFAULT_CONFIG } = await imp('config.js');
const { contractHash } = await imp('plan.js');
const { offerRoute } = await imp('router-selection.js');
const { claudeCandidates } = await imp('claude-candidates.js');
const { routingContext } = await imp('router-context.js');
const { ordered } = await imp('bench/router.js');
const out = { gateA: [], gateB: [], gateBPlanner: [], router: [] };
for (const it of JSON.parse(readFileSync(R + '/bench/v5/admission-set.json', 'utf8')).items) out.gateA.push(JSON.stringify(buildAtomicAdmissionRequest(it.prompt, DEFAULT_CONFIG)));
const set = JSON.parse(readFileSync(R + '/bench/v5/gate-b-set.json', 'utf8'));
for (const it of set.worker) {
  const base = { id: 't1', outcome: it.outcome, depends_on: [], context: it.context, constraints: it.constraints, deliverables: it.deliverables, checks: it.checks.map((c) => ({ ...c, required: true })), replan_if: [], ...(it.spec ? { spec: { data_shapes: [], ...it.spec } } : {}), ...(it.fully_specified !== undefined ? { fully_specified: it.fully_specified } : {}), ...(it.uncertainty ? { uncertainty: it.uncertainty } : {}) };
  const t = { ...base, contract_hash: contractHash(base) };
  const p = it.prior_attempt ? { attempt: it.prior_attempt.attempt, verdict: it.prior_attempt.verdict, verdict_reason: it.prior_attempt.verdict_reason, status: it.prior_attempt.status, summary: it.prior_attempt.summary, blockers: it.prior_attempt.blockers, failed_checks: it.prior_attempt.failed_checks, observed_model_confirmed: true, provenance: 'host_observed' } : null;
  out.gateB.push(JSON.stringify(alloc.buildAtomicWorkerRouteRequest(t, [], [], 'Complete task t1 of the approved plan. The contract below is authoritative.', it.called, DEFAULT_CONFIG, p, it.request)));
}
for (const it of set.planner) out.gateBPlanner.push(JSON.stringify(alloc.buildPlannerRouteRequest(it.request, DEFAULT_CONFIG)));
const args = { baseline: { model: 'claude-opus-5-5', effort: 'xhigh' }, candidates: claudeCandidates({ baseline: 'claude-opus-5-5', aliases: {}, allowFable: false }), model: true, effort: true, upgrade: 0.8, downgrade: 0.6, scope: 'root' };
const offer = ordered(offerRoute(args), true);
const golden = JSON.parse(readFileSync(R + '/bench/router/golden.json', 'utf8')).items.filter((i) => i.split === 'dev').slice(0, 30);
for (const it of golden) out.router.push(JSON.stringify({ model: DEFAULT_CONFIG.jevModel, state: routingContext(it.text), questions: offer.questions }));
writeFileSync('corpus-a.json', JSON.stringify(out));
const sz = (a) => { const s = a.map((x) => Buffer.byteLength(x)).sort((x, y) => x - y); return `n ${s.length} p50 ${s[Math.floor((s.length - 1) / 2)]} max ${s[s.length - 1]} min ${s[0]}`; };
for (const [k, v] of Object.entries(out)) console.log(k, sz(v));
