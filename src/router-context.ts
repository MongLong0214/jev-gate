import { looksSecret } from './router-secret.ts';
export interface RoutingCache {
  model: string; input: number | null; read: number | null; write: number | null; ageMs: number;
  source?: 'provider_response_usage' | 'host_usage';
  ttlMs?: number | null; epoch?: string; output?: number | null;
}

/** The characters of each earlier turn a root question sends, from its end. */
export const CONTEXT_TAIL = 2000;
/** The person's earlier requests a root question sends. */
export const RECENT_REQUESTS = 3;

/** Same input contract for every root adapter; screen whole previous turns before taking their tail. */
export const routingContext = (text: string, previousReply?: string, recentRequests: readonly string[] = [], cache?: RoutingCache) => ({
  task: {
    text, source: 'current_human_request', truncated: false,
    ...(previousReply?.trim() && !looksSecret(previousReply) ? { previous_reply: previousReply.slice(-CONTEXT_TAIL), previous_reply_source: 'completed_visible_assistant_reply', previous_reply_truncated: previousReply.length > CONTEXT_TAIL } : {}),
    recent_requests: recentRequests.filter(t => t.trim() && !looksSecret(t)).slice(-RECENT_REQUESTS).map(t => ({ text: t.slice(-CONTEXT_TAIL), source: 'recent_human_request', truncated: t.length > CONTEXT_TAIL })),
  },
  ...(cache ? { execution: { scope: 'root', cache: { source: cache.source ?? 'provider_response_usage', previous_model: cache.model,
    input_tokens: cache.input, cache_read_tokens: cache.read, cache_write_tokens: cache.write, age_ms: cache.ageMs, ttl_ms: cache.ttlMs ?? null, epoch: cache.epoch ?? null,
    current_fit_proven: false, cross_model_reuse_proven: false } } } : {}),
});
