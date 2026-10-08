import { factsOf } from './claude-models.ts';

export interface ClaudeCacheCapability { host: string | undefined; connection: 'api-key' | 'bearer' | 'unknown'; excluded: boolean; hipaa: boolean | null }
/** API support is not proof that a gateway or HIPAA account enables the beta. */
export const claudeEffortCache = (model: string, v: ClaudeCacheCapability): 'supported' | 'capability_unknown' | 'excluded' => {
  if (v.excluded || v.hipaa === true) return 'excluded';
  const release = /^2\.1\.(\d+)$/.exec(v.host ?? '');
  const facts = factsOf(model);
  return release && Number(release[1]) >= 288 && facts && !facts.legacy &&
    v.connection !== 'unknown' && v.hipaa === false ? 'supported' : 'capability_unknown';
};

/** A missing counter is inconclusive; this compares a real effort change with its preceding prefix. */
export const effortCacheHit = (before: { read: number | null; write: number | null }, after: { read: number | null }): boolean | null => {
  if (before.read === null || before.write === null || after.read === null || before.read + before.write <= 0) return null;
  return after.read >= 0.98 * (before.read + before.write);
};
