import { sameModel } from './claude-models.js';
import { normalizeUsage, type TokenUsage } from './cost.js';

// The host's response waits on this read (n 1663: p50 135 ms, p90 1563 ms at 1500). Past 300 ms the root's response
// keeps its effort and TTL unknown in memory: the next switch that turn prices that cache as unknown (a range) until a
// later response is linked. The trace record still gets them from the hook's --defer reconciliation.
export const ROUTER_OBSERVATION_WAIT_MS = 300;
// Leave startup/serialization room beyond the bounded transcript flush wait.
export const ROUTER_OBSERVATION_PROCESS_MS = ROUTER_OBSERVATION_WAIT_MS + 500;

export interface RouterObservation {
  effort: string | number | null;
  request: string;
  model: string;
  usage: TokenUsage;
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Only metadata from the current response and its exact api-request, never a previous request's effort or TTL. */
export const routerObservation = (text: string, session: string, agent: string, since: number, raw: unknown, until = Infinity): RouterObservation | null => {
  const expected = normalizeUsage('claude', raw), model = object(raw)['model'];
  if (expected.coverage !== 'complete' || typeof model !== 'string' || !Number.isFinite(since)) return null;
  const rows = text.split('\n').flatMap(line => { try { return [object(JSON.parse(line))]; } catch { return []; } })
    .filter(r => r['sessionId'] === session && (r['agentId'] ?? '') === agent);
  const requests = new Map(rows.filter(r => r['type'] === 'api-request' && typeof r['id'] === 'string' &&
    typeof r['timestamp'] === 'string' && Date.parse(r['timestamp']) >= since && Date.parse(r['timestamp']) <= until).map(r => [r['id'], r]));
  const matches = new Map<string, RouterObservation>();
  for (const row of rows) {
    if (row['type'] !== 'assistant') continue;
    const message = object(row['message']), ref = row['requestRef'];
    const request = requests.get(ref), params = object(request?.['params']);
    if (!request || typeof ref !== 'string' || typeof params['model'] !== 'string' || message['model'] !== model || !sameModel(params['model'], model)) continue;
    const usage = normalizeUsage('claude', message['usage']);
    if (usage.coverage !== 'complete' || !(['input', 'read', 'write', 'output'] as const).every(k => usage[k] === expected[k])) continue;
    const effort = object(params['output_config'])['effort'];
    const known = typeof effort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) || typeof effort === 'number' && Number.isSafeInteger(effort) && effort >= 0;
    matches.set(ref, { request: ref, model: params['model'], effort: known ? effort as string | number : null, usage });
  }
  return matches.size === 1 ? [...matches.values()][0]! : null;
};

