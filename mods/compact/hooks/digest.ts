/**
 * The extractive compaction: the conversation before a recent tail becomes one built user message (the digest), and
 * the tail stays as the engine has it (by handle). No model is asked, so a compaction costs no request and no wait.
 *
 * The shape is structural so the Node tests and the offline evaluation drive the same function the host runs; the
 * host's `SessionMessage` satisfies it.
 */
export interface DigestToolUse {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly text?: string;
}

export interface DigestMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly toolUses: readonly DigestToolUse[];
  readonly toolResults?: ReadonlyArray<{ readonly text: string }>;
  readonly handle?: string;
}

export interface DigestOptions {
  /** Characters for the digest and the kept tail together. */
  readonly budgetChars: number;
}

export interface DigestResult {
  /** The built user message's text; it replaces every message before `start`. */
  readonly digest: string;
  /** Index of the first message kept as the engine has it. */
  readonly start: number;
  readonly digestChars: number;
  readonly tailChars: number;
  readonly tailMessages: number;
  readonly headMessages: number;
}

export type DigestOutcome = { ok: true; result: DigestResult } | { ok: false; reason: 'nothing_to_compact' | 'tail_too_large' };

/** Marks a digest this module wrote, so the next compaction carries it forward as the previous summary. */
export const DIGEST_MARK = '[jev-gate compact]';
const CORE_SUMMARY = 'This session is being continued from a previous conversation';

/** Shares of the budget; the rest of the digest goes to the log and then to result excerpts, newest first. */
const TAIL_SHARE = 0.4;
/** The digest keeps this share even when the tail's minimum takes more than its own. */
const DIGEST_FLOOR = 0.3;
const MINIMAL_TAIL_BUDGETS = 2;
const SUMMARY_SHARE = 0.3;
const LAST_REQUEST_CHARS = 2000;
const REQUEST_CHARS = 400;
const NARRATION_CHARS = 400;
const INPUT_CHARS = 240;
const RESULT_CHARS = 1200;
const CUT = ' […]';

const HEADER = `${DIGEST_MARK} This conversation was compacted without a model summary. Below is an extract of the earlier part: the previous summary, the user's requests, and a log of earlier steps (oldest first) with each tool call's input and, where room allowed, an excerpt of its output. Text cut to fit ends in "[…]"; re-read the source if you need it whole. The conversation continues verbatim after this message.`;

/** Engine-injected user text that is not a request from the person. */
const NOT_A_REQUEST = /^\s*(?:<(?:system-reminder|task-notification|local-command|command-|user-prompt-submit-hook)|Caveat:)/;

const clip = (s: string, n: number): string => (s.length <= n ? s : n <= CUT.length ? s.slice(0, n) : s.slice(0, n - CUT.length) + CUT);

const inputText = (u: DigestToolUse): string => {
  let json: string;
  try {
    json = JSON.stringify(u.input) ?? '';
  } catch {
    json = '';
  }
  return `${u.tool} ${json}`;
};

/** What a kept message costs in the context, near enough: its text, tool inputs and tool results. */
export const messageChars = (m: DigestMessage): number =>
  m.text.length +
  (m.role === 'assistant' ? m.toolUses.reduce((n, u) => n + inputText(u).length, 0) : 0) +
  (m.toolResults ?? []).reduce((n, r) => n + r.text.length, 0);

const isSummary = (m: DigestMessage): boolean =>
  m.role === 'user' && (m.text.trimStart().startsWith(CORE_SUMMARY) || m.text.trimStart().startsWith(DIGEST_MARK));

const isRequest = (m: DigestMessage): boolean =>
  m.role === 'user' && (m.toolResults ?? []).length === 0 && m.text.trim() !== '' && !isSummary(m) && !NOT_A_REQUEST.test(m.text);

/**
 * The tail starts at an assistant message, so every tool_result in it answers a tool_use in it and the digest (a
 * user message) is followed by an assistant one. It grows back from the end within its share, and always holds the
 * last assistant message and what follows it (often the large result that crossed the threshold) up to twice the
 * budget; past that the compaction is left to the engine.
 */
const tailStart = (messages: readonly DigestMessage[], tailBudget: number, budget: number): number | null => {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant <= 0) return null;
  const minimal = messages.slice(lastAssistant).reduce((n, m) => n + messageChars(m), 0);
  if (minimal > MINIMAL_TAIL_BUDGETS * budget) return null;
  let used = 0;
  let start = lastAssistant;
  for (let i = messages.length - 1; i >= 0; i--) {
    used += messageChars(messages[i]!);
    if (used > tailBudget) break;
    if (messages[i]!.role === 'assistant') start = Math.min(start, i);
  }
  return start;
};

interface Piece {
  at: number;
  sub: number;
  text: string;
}

const SECTION = {
  summary: '## Previous summary',
  requests: '## User requests (oldest first)',
  steps: '## Earlier steps (oldest first)',
} as const;
const REQUEST_PREFIX = '▸ ';

interface Carried {
  summary: string;
  requests: string[];
  steps: string[];
}

/**
 * The previous summary. One this module wrote is taken apart rather than nested whole, so its requests and steps join
 * the new ones and only its own previous summary is carried as a summary: nested, the cut would keep the oldest text
 * and drop the newest.
 */
const carried = (text: string): Carried => {
  const t = text.trim();
  if (!t.startsWith(DIGEST_MARK)) return { summary: t, requests: [], steps: [] };
  const at = (h: string): number => t.indexOf(`\n\n${h}\n`);
  const bounds = [SECTION.summary, SECTION.requests, SECTION.steps].map(at);
  const part = (k: number): string => {
    const s = bounds[k]!;
    if (s < 0) return '';
    const end = bounds.slice(k + 1).find((b) => b > s);
    return t.slice(s + [SECTION.summary, SECTION.requests, SECTION.steps][k]!.length + 3, end ?? t.length);
  };
  const requests = part(1);
  return {
    summary: part(0).trim(),
    requests: requests ? requests.replace(/^▸ /, '').split(`\n${REQUEST_PREFIX}`) : [],
    steps: part(2).split('\n').filter((l) => l.trim() !== ''),
  };
};

/** The conversation after the compaction: the digest as a built user message, then the kept tail as it came. */
export const assemble = <M extends DigestMessage>(messages: readonly M[], r: DigestResult): Array<M | { role: 'user'; text: string; toolUses: [] }> => [
  { role: 'user', text: r.digest, toolUses: [] },
  ...messages.slice(r.start),
];

export const buildDigest = (messages: readonly DigestMessage[], options: DigestOptions): DigestOutcome => {
  const budget = options.budgetChars;
  const start = tailStart(messages, Math.floor(budget * TAIL_SHARE), budget);
  if (start === null) return { ok: false, reason: messages.some((m) => m.role === 'assistant') ? 'tail_too_large' : 'nothing_to_compact' };
  const head = messages.slice(0, start);
  const tail = messages.slice(start);
  if (head.length === 0) return { ok: false, reason: 'nothing_to_compact' };
  const tailChars = tail.reduce((n, m) => n + messageChars(m), 0);

  // Headings and separators are paid for up front; each piece pays for its own prefix and line break.
  const frame = HEADER.length + Object.values(SECTION).reduce((n, h) => n + h.length + 3, 0);
  let left = Math.max(budget - tailChars, Math.floor(budget * DIGEST_FLOOR)) - frame;
  const take = (text: string, cap: number, overhead: number): string => {
    const room = Math.min(cap, left - overhead);
    if (room <= 0) return '';
    const t = clip(text, room);
    left -= t.length + overhead;
    return t;
  };

  let prior: Carried = { summary: '', requests: [], steps: [] };
  for (let i = head.length - 1; i >= 0; i--) {
    if (isSummary(head[i]!)) {
      prior = carried(head[i]!.text);
      break;
    }
  }
  const summary = take(prior.summary, Math.floor(budget * SUMMARY_SHARE), 0);

  // Requests, the carried ones first in time: the newest gets the most room.
  const asked: Piece[] = [
    ...prior.requests.map((text, k) => ({ at: k - prior.requests.length, sub: 0, text })),
    ...head.flatMap((m, i) => (isRequest(m) ? [{ at: i, sub: 0, text: m.text.trim() }] : [])),
  ];
  const requests: Piece[] = [];
  [...asked].reverse().forEach((p, k) => {
    const t = take(p.text, k === 0 ? LAST_REQUEST_CHARS : REQUEST_CHARS, REQUEST_PREFIX.length + 1);
    if (t) requests.push({ ...p, text: t });
  });

  // Steps: this stretch's inputs and narration, then its result excerpts, newest first; then carried steps. Recency
  // orders them rather than a Jev relevance score, which over 40 real compactions kept no more of what the next turns
  // used (0.783 against 0.788).
  const log: Piece[] = [];
  for (let i = head.length - 1; i >= 0 && left > 0; i--) {
    const m = head[i]!;
    if (m.role !== 'assistant') continue;
    m.toolUses.forEach((u, j) => {
      const t = take(inputText(u), INPUT_CHARS, 3);
      if (t) log.push({ at: i, sub: 1 + 2 * j, text: `[${t}]` });
    });
    if (m.text.trim()) {
      const t = take(m.text.trim(), NARRATION_CHARS, 1);
      if (t) log.push({ at: i, sub: 0, text: t });
    }
  }
  for (let i = head.length - 1; i >= 0 && left > 0; i--) {
    const m = head[i]!;
    if (m.role !== 'assistant') continue;
    m.toolUses.forEach((u, j) => {
      if (!u.text) return;
      const t = take(u.text.trim(), RESULT_CHARS, 5);
      if (t) log.push({ at: i, sub: 2 + 2 * j, text: `  → ${t}` });
    });
  }
  for (let k = prior.steps.length - 1; k >= 0 && left > 0; k--) {
    const t = take(prior.steps[k]!, RESULT_CHARS, 1);
    if (t) log.push({ at: k - prior.steps.length, sub: 0, text: t });
  }

  const order = (a: Piece, b: Piece): number => a.at - b.at || a.sub - b.sub;
  const sections = [HEADER];
  if (summary) sections.push(`${SECTION.summary}\n${summary}`);
  if (requests.length) sections.push(`${SECTION.requests}\n${requests.sort(order).map((p) => REQUEST_PREFIX + p.text).join('\n')}`);
  if (log.length) sections.push(`${SECTION.steps}\n${log.sort(order).map((p) => p.text).join('\n')}`);
  const digest = sections.join('\n\n');

  return {
    ok: true,
    result: {
      digest,
      start,
      digestChars: digest.length,
      tailChars,
      tailMessages: tail.length,
      headMessages: head.length,
    },
  };
};
