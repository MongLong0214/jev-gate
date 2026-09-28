import type { ChoiceAnswer } from '../types.js';
import { LIMITS, type Judgement } from './types.js';

type Answers = Record<string, ChoiceAnswer<Judgement>>;

export interface JudgementCache {
  get: (key: string) => Answers | undefined;
  set: (key: string, answers: Answers) => void;
  size: () => number;
}

/**
 * Completed, fully valid batch answers only, keyed by a digest of everything the batch asked (so no goal or source
 * text is held here), for ten minutes, in at most 128 entries and 2 MiB. Nothing is written anywhere else; a restart
 * starts empty. Eviction is insertion order, on write; an expired entry is dropped when it is read.
 */
export const createJudgementCache = (now: () => number = Date.now): JudgementCache => {
  const entries = new Map<string, { at: number; bytes: number; answers: Answers }>();
  let bytes = 0;
  const drop = (key: string): void => {
    const e = entries.get(key);
    if (!e) return;
    bytes -= e.bytes;
    entries.delete(key);
  };
  return {
    get: (key) => {
      const e = entries.get(key);
      if (!e) return undefined;
      if (now() - e.at > LIMITS.cacheTtlMs) {
        drop(key);
        return undefined;
      }
      return e.answers;
    },
    set: (key, answers) => {
      const size = key.length + Buffer.byteLength(JSON.stringify(answers), 'utf8');
      if (size > LIMITS.cacheBytes) return;
      drop(key);
      entries.set(key, { at: now(), bytes: size, answers });
      bytes += size;
      for (const oldest of entries.keys()) {
        if (entries.size <= LIMITS.cacheEntries && bytes <= LIMITS.cacheBytes) break;
        drop(oldest);
      }
    },
    size: () => entries.size,
  };
};
