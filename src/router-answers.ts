export interface ScoreAnswer { levels: readonly number[] }
export interface ChoiceAnswer<K extends string = string> { choice: K; confidence: number; probabilities: Readonly<Record<string, number>> }
export const PROB_SUM_TOLERANCE = 1e-3;
export const ARGMAX_TOLERANCE = 1e-6;
/**
 * Jev rounds each probability to two decimals, so a correct answer can miss a sum of 1 by up to half a hundredth per
 * label: 0.05 + 0.93 + 0.01 = 0.99 came back 3 times in 40 identical requests on 2026-09-28. Within that allowance the
 * distribution is rescaled to sum to 1 rather than read as given, since the floors read its mass; beyond it the
 * answer is still not an answer.
 */
export const ROUNDING_PER_LABEL = 0.005;
export const HUNDREDTHS_TOLERANCE = 1e-9;

/**
 * What each probability is divided by: 1 when they sum to 1; their sum when every one is a two-decimal value, the sum is
 * positive and it misses 1 by no more than that rounding; otherwise null. Rescaling is kept to two-decimal answers
 * rather than any sum that is near 1, because it spreads values apart: two values less than ARGMAX_TOLERANCE apart can
 * end up more than that apart, and a tie becomes a winner. Two-decimal values are either equal or at least 0.01 apart,
 * so rescaling keeps their ties and their order.
 */
const scaleOf = (probs: readonly number[]): number | null => {
  const sum = probs.reduce((x, y) => x + y, 0);
  const miss = Math.abs(sum - 1);
  if (miss <= PROB_SUM_TOLERANCE) return 1;
  if (sum <= 0 || miss > probs.length * ROUNDING_PER_LABEL + PROB_SUM_TOLERANCE) return null;
  return probs.every((p) => Math.abs(p * 100 - Math.round(p * 100)) <= HUNDREDTHS_TOLERANCE) ? sum : null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Exact label set, finite probabilities in [0,1] summing to 1 up to Jev's rounding, and a UNIQUE maximum within 1e-6
 * of the returned probabilities that is the stated choice. A tie is not an answer: nothing about it says which side to
 * take.
 */
export const validateChoice = (value: unknown, keys: readonly string[]): ChoiceAnswer | null => {
  if (!isRecord(value) || value['type'] !== 'choice') return null;
  const choice = value['choice'];
  if (typeof choice !== 'string' || !keys.includes(choice)) return null;
  const probs = value['probabilities'];
  if (!isRecord(probs)) return null;
  const probKeys = Object.keys(probs);
  if (probKeys.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(probs, k))) return null;
  for (const k of keys) {
    const p = probs[k];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
  }
  const scale = scaleOf(keys.map((k) => probs[k] as number));
  if (scale === null) return null;
  const probabilities: Record<string, number> = Object.fromEntries(keys.map((k) => [k, (probs[k] as number) / scale]));
  const max = Math.max(...keys.map((k) => probabilities[k] as number));
  const top = keys.filter((k) => (probabilities[k] as number) >= max - ARGMAX_TOLERANCE);
  if (top.length !== 1 || top[0] !== choice) return null;
  const confidence = value['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { choice, confidence, probabilities };
};

/** Exactly one finite probability in [0,1] per level index, summing to 1 up to Jev's rounding. `score` and `legend` are not read. */
export const validateScore = (value: unknown, levels: number): ScoreAnswer | null => {
  if (!isRecord(value) || value['type'] !== 'score') return null;
  const probs = value['probabilities'];
  if (!isRecord(probs) || Object.keys(probs).length !== levels) return null;
  const out: number[] = [];
  for (let i = 0; i < levels; i++) {
    const p = probs[String(i)];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
    out.push(p);
  }
  const scale = scaleOf(out);
  return scale === null ? null : { levels: out.map((p) => p / scale) };
};

