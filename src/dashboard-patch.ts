import type { ActivitySnapshot } from './activity.js';
import type { OperationRun, OperationStep, OperationsView } from './operations.js';

/** Live updates after the first frame carry only what changed. A run that is the same object as last time is skipped
 * without serializing it, and a changed run sends only its new or changed steps, so one new record costs bytes, not the
 * whole history. Keys advance only when content changes, so an unchanged rebuild sends nothing. */
interface RunMemo { run: FrameRun; meta: string; steps: Map<string, string> | null }
type Fields = Map<string, { value: unknown; json: string | undefined }>;
/** Step fields only an opened stage detail or a decision basis shows. Frames leave them out, about half of a long history's
 * bytes; the page fetches them for the one opened stage and the shown calls from `/api/step`. A step without `details` is such a frame step. */
type DetailField = 'details' | 'routing' | 'sessionId' | 'agentId' | 'judgements';
export type FrameStep = Omit<OperationStep, DetailField>;
export type FrameRun = Omit<OperationRun, 'steps'> & { steps: FrameStep[] };
type FrameOperations = Omit<OperationsView, 'runs' | 'feed'> & { runs: FrameRun[]; feed: Array<FrameStep & { runId: string; runTitle: string; host?: OperationRun['host'] }> };
/** What a frame carries: the snapshot fields the page draws. */
export type FrameSnapshot = Omit<Partial<ActivitySnapshot>, 'operations'> & { operations: FrameOperations };
const frameStep = <T extends OperationStep>({ details: _details, routing: _routing, sessionId: _session, agentId: _agent, judgements: _judgements, ...shown }: T): Omit<T, DetailField> => shown;
// An unchanged run keeps its object across rebuilds, and so does its frame run, so the diff still skips it by identity. A
// changed run keeps the steps that did not change, and so do their frame steps, so the diff serializes only the new ones.
const frameRuns = new WeakMap<OperationRun, FrameRun>(), frameSteps = new WeakMap<OperationStep, FrameStep>();
const shownStep = (step: OperationStep): FrameStep => { let out = frameSteps.get(step); if (!out) frameSteps.set(step, out = frameStep(step)); return out; };
const frameRun = (run: OperationRun): FrameRun => { let out = frameRuns.get(run); if (!out) frameRuns.set(run, out = { ...run, steps: run.steps.map(shownStep) }); return out; };
export const frameOperations = (ops: OperationsView): FrameOperations => ({ ...ops, runs: ops.runs.map(frameRun), feed: ops.feed.map(frameStep) });
export interface FrameMemo { key: string; top: Fields; ops: Fields; order: string[]; runs: Map<string, RunMemo>; feed: Map<string, string> }

/** The snapshot fields whose change alone is no news: the build time moves on every rebuild. */
const QUIET = new Set(['at']);
const feedKey = (s: { runId: string; id: string }): string => `${s.runId}\n${s.id}`;
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const fields = (o: object): Fields => new Map(Object.entries(o).map(([k, value]) => [k, { value, json: JSON.stringify(value) }]));
// A step at the same place as last time, and the same object, has the same text; new steps usually come last.
const memoRun = (run: FrameRun, old: RunMemo | undefined): RunMemo & { fields: Omit<FrameRun, 'steps'> } => {
  const { steps, ...meta } = run, json = new Map<string, string>();
  steps.forEach((step, i) => json.set(step.id, (old?.run.steps[i] === step ? old.steps?.get(step.id) : undefined) ?? JSON.stringify(step)));
  return { run, fields: meta, meta: JSON.stringify(meta), steps: json.size === steps.length ? json : null };
};

/** Compares a new snapshot with the last frame. `patch` is null when nothing but the build time changed; the memo then
 * stays at the last frame, so the next patch still applies to what viewers hold. */
export const diffFrame = (prev: FrameMemo | null, snapshot: FrameSnapshot, nextKey: () => string): { memo: FrameMemo; patch: string | null } => {
  const { operations, ...rest } = snapshot, { runs, feed, ...opsRest } = operations;
  const top = fields(rest), ops = fields(opsRest);
  const order = runs.map(run => run.id);
  const feedJson = new Map(feed.map(s => [feedKey(s), JSON.stringify(s)]));
  const memos = new Map<string, RunMemo>();
  const runPatch: Record<string, unknown> = {};
  for (const run of runs) {
    const old = prev?.runs.get(run.id);
    if (old?.run === run) { memos.set(run.id, old); continue; }
    const { fields: meta, ...memo } = memoRun(run, old); memos.set(run.id, memo);
    if (!old || !memo.steps || !old.steps) { runPatch[run.id] = { run }; continue; }
    const put: Record<string, unknown> = {};
    for (const step of run.steps) if (old.steps.get(step.id) !== memo.steps.get(step.id)) put[step.id] = step;
    const ids = run.steps.map(s => s.id);
    if (memo.meta === old.meta && !Object.keys(put).length && same(ids, [...old.steps.keys()])) continue;
    runPatch[run.id] = { meta, steps: ids, put };
  }
  const memo: FrameMemo = { key: prev?.key ?? '', top, ops, order, runs: memos, feed: feedJson };
  if (!prev) return { memo: { ...memo, key: nextKey() }, patch: null };
  const p: Record<string, unknown> = {};
  // A field that became absent is listed for removal, as a whole frame would leave it out; null stays a value.
  const changed = (now: Fields, before: Fields): { set: Record<string, unknown> | null; drop: string[] | null } => {
    const set: Record<string, unknown> = {}, drop: string[] = [];
    for (const [k, { value, json }] of now) if (before.get(k)?.json !== json) { if (json === undefined) drop.push(k); else set[k] = value; }
    for (const [k, { json }] of before) if (json !== undefined && !now.has(k)) drop.push(k);
    return { set: Object.keys(set).length ? set : null, drop: drop.length ? drop : null };
  };
  const { set, drop } = changed(top, prev.top), opsChange = changed(ops, prev.ops);
  if (opsChange.set) p['ops'] = opsChange.set;
  if (opsChange.drop) p['opsDrop'] = opsChange.drop;
  if (drop) p['drop'] = drop;
  if (!same(order, prev.order)) p['order'] = order;
  if (Object.keys(runPatch).length) p['runs'] = runPatch;
  const feedKeys = [...feedJson.keys()];
  if (feedJson.size !== feed.length) p['feed'] = { all: feed };
  else if (!same(feedKeys, [...prev.feed.keys()]) || feedKeys.some(k => prev.feed.get(k) !== feedJson.get(k))) {
    const put: Record<string, unknown> = {};
    for (const s of feed) { const k = feedKey(s); if (prev.feed.get(k) !== feedJson.get(k)) put[k] = s; }
    p['feed'] = { ids: feedKeys, put };
  }
  const news = Object.keys(p).length > 0 || set !== null && Object.keys(set).some(k => !QUIET.has(k));
  if (!news) return { memo: prev, patch: null };
  if (set) p['set'] = set;
  return { memo: { ...memo, key: nextKey() }, patch: JSON.stringify(p) };
};

/** The page's half: `applyPatch(frame, message)` returns the next frame, or null when the message does not follow the frame
 * it holds (the page then reconnects for a whole frame). Unchanged runs and steps keep their objects, so the page can skip
 * redrawing them by identity. */
export const PATCH_SCRIPT = String.raw`
function applyPatch(prev,m){if(!prev||!m||m.base!==prev.frame)return null;const next={...prev,frame:m.frame};if(m.extra)Object.assign(next,m.extra);const p=m.p;if(!p)return next;
  if(p.set)Object.assign(next,p.set);if(p.drop)for(const k of p.drop)delete next[k];
  if(p.ops||p.opsDrop||p.order||p.runs||p.feed){const o=prev.operations;if(!o)return null;const ops=next.operations={...o,...p.ops};if(p.opsDrop)for(const k of p.opsDrop)delete ops[k];
    if(p.order||p.runs){const old=new Map(o.runs.map(r=>[r.id,r]));let ok=true;
      ops.runs=(p.order||o.runs.map(r=>r.id)).map(id=>{const rp=p.runs&&p.runs[id];if(!rp){const r=old.get(id);if(!r)ok=false;return r}if(rp.run)return rp.run;const before=old.get(id);if(!before){ok=false;return null}const known=new Map(before.steps.map(s=>[s.id,s]));
        return {...rp.meta,steps:rp.steps.map(sid=>{const s=rp.put[sid]||known.get(sid);if(!s)ok=false;return s})}});if(!ok)return null}
    if(p.feed){if(p.feed.all)ops.feed=p.feed.all;else{const known=new Map(o.feed.map(s=>[s.runId+'\n'+s.id,s]));let ok=true;ops.feed=p.feed.ids.map(k=>{const s=p.feed.put[k]||known.get(k);if(!s)ok=false;return s});if(!ok)return null}}}
  return next}`;
