/**
 * The extractive compaction: the conversation before a recent tail becomes one built user message (the digest), and
 * the tail stays as the engine has it (by handle), its last message rebuilt when it answers calls (CLOSING). No model
 * is asked, so a compaction costs no request and no wait.
 *
 * The shape is structural so the Node tests and the offline evaluation drive the same function the host runs; the
 * host's `SessionMessage` satisfies it.
 */
export interface DigestToolUse {
  readonly tool_use_id?: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly text?: string;
}

export interface DigestMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly toolUses: readonly DigestToolUse[];
  readonly toolResults?: ReadonlyArray<{ readonly text: string; readonly tool_use_id?: string; readonly isError?: boolean }>;
  readonly handle?: string;
}

export interface DigestOptions {
  /**
   * Target characters for the digest and the kept tail together. The last exchange is kept whole, so when it alone is
   * over the tail's share the total can reach 2.3 times this (twice for the tail, 30% for the digest); past twice, the
   * engine compacts. Either way the result must come to at most half of what it replaces.
   */
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

export type DigestFallback = 'nothing_to_compact' | 'tail_too_large' | 'pending_call' | 'unpaired_result' | 'opaque_result' | 'no_relief';
export type DigestOutcome = { ok: true; result: DigestResult } | { ok: false; reason: DigestFallback };

/** Marks a digest this module wrote, so the next compaction carries it forward as the previous summary. */
export const DIGEST_MARK = '[jev-gate compact]';
const CORE_SUMMARY = 'This session is being continued from a previous conversation that ran out of context.';

/** Shares of the budget; the rest of the digest goes to the log and then to result excerpts, newest first. */
const TAIL_SHARE = 0.4;
/** The digest keeps this share even when the tail's minimum takes more than its own. */
const DIGEST_FLOOR = 0.3;
const MINIMAL_TAIL_BUDGETS = 2;
/** A compaction whose digest and tail would not come to at most this share of what it replaces is left to the engine. */
const RELIEF = 0.5;
const SUMMARY_SHARE = 0.3;
const LAST_REQUEST_CHARS = 2000;
const REQUEST_CHARS = 400;
const NARRATION_CHARS = 400;
const INPUT_CHARS = 240;
const RESULT_CHARS = 1200;
const CUT = ' […]';
const REQUEST_HEAD_SHARE = 0.5;
const SUMMARY_HEAD_SHARE = 0.3;
/** What a message and each tool call or result in it cost beyond their text, near enough: the id and the structure. */
const MESSAGE_OVERHEAD = 16;
const BLOCK_OVERHEAD = 40;

const HEADER = `${DIGEST_MARK} This conversation was compacted without a model summary. Below is an extract of the earlier part: the previous summary, the user's requests, and a log of earlier steps (oldest first) with each tool call's input and, where room allowed, an excerpt of its output. Text cut to fit is marked "[…]"; re-read the source if you need it whole. The conversation continues verbatim after this message.`;

/**
 * Text the engine adds to a user message: blocks in its own tags, and the caveat it puts before command output. A user
 * message's text blocks come joined, so these are cut out and what remains is the person's request, rather than the
 * whole message being judged by how it starts. Only a block that starts a line is cut, as the engine's own text blocks
 * do, rather than every tag-shaped span: a tag quoted inside a sentence stays part of the request.
 */
const INJECTED_TAGS = 'system-reminder|task-notification|local-command-[a-z-]+|command-[a-z-]+|bash-(?:input|stdout|stderr)|user-prompt-submit-hook';
const OPEN_TAG = new RegExp(`[ \\t]*<(${INJECTED_TAGS})>`, 'y');
const CLOSE_TAG = new RegExp(`</(${INJECTED_TAGS})>`, 'g');

/**
 * Cut the engine's blocks, each from a line start (or the end of the block cut before it on that line) to its closing
 * tag. One pass over the text rather than a regex per block: an open tag with no close must not rescan the rest, or a
 * long pasted log would hold up the host's compaction.
 */
const withoutInjected = (text: string): string => {
  const closes = new Map<string, number[]>();
  for (const m of text.matchAll(CLOSE_TAG)) {
    const at = closes.get(m[1]!);
    if (at) at.push(m.index);
    else closes.set(m[1]!, [m.index]);
  }
  if (closes.size === 0) return text;
  /** The first close of `name` at or after `from`; the positions are ascending. */
  const closeAfter = (name: string, from: number): number => {
    const at = closes.get(name);
    if (!at) return -1;
    let lo = 0;
    let hi = at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at[mid]! < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < at.length ? at[lo]! : -1;
  };
  const kept: string[] = [];
  let copied = 0;
  let at = 0;
  while (at <= text.length) {
    OPEN_TAG.lastIndex = at;
    const open = OPEN_TAG.exec(text);
    const end = open ? closeAfter(open[1]!, OPEN_TAG.lastIndex) : -1;
    if (open && end >= 0) {
      kept.push(text.slice(copied, at));
      copied = end + open[1]!.length + 3;
      at = copied;
      continue;
    }
    const nl = text.indexOf('\n', at);
    if (nl < 0) break;
    at = nl + 1;
  }
  kept.push(text.slice(copied));
  return kept.join('');
};
const CAVEAT =
  'Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.';

const clip = (s: string, n: number): string => (s.length <= n ? s : n <= CUT.length ? s.slice(0, n) : s.slice(0, n - CUT.length) + CUT);
/** Cut from the middle: the start and, by `headShare`, more or less of the end survive. */
const clipMiddle = (s: string, n: number, headShare: number): string => {
  if (s.length <= n) return s;
  const keep = n - CUT.length - 1;
  if (keep <= 0) return s.slice(0, n);
  const head = Math.floor(keep * headShare);
  return `${s.slice(0, head)}${CUT} ${s.slice(s.length - (keep - head))}`;
};

/** FNV-1a over the text exactly: a digest changed anywhere inside no longer matches. */
const checksum = (text: string): string => {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};
const END_OPEN = '[jev-gate compact end ';
const END = (sum: string): string => `${END_OPEN}${sum}]`;
const END_LENGTH = END('00000000').length + 2;

const inputText = (u: DigestToolUse): string => {
  let json: string;
  try {
    json = JSON.stringify(u.input) ?? '';
  } catch {
    json = '';
  }
  return `${u.tool} ${json}`;
};

/**
 * What a kept message costs in the context, near enough: its text, its tool calls and results with their ids, and the
 * structure around each, so a stretch of many small calls is not counted as nearly free.
 */
export const messageChars = (m: DigestMessage): number =>
  MESSAGE_OVERHEAD +
  m.text.length +
  (m.role === 'assistant' ? m.toolUses.reduce((n, u) => n + inputText(u).length + (u.tool_use_id?.length ?? 0) + BLOCK_OVERHEAD, 0) : 0) +
  (m.toolResults ?? []).reduce((n, r) => n + r.text.length + (r.tool_use_id?.length ?? 0) + BLOCK_OVERHEAD, 0);

/**
 * A digest this module wrote: the whole header, and a last line carrying a checksum of everything before it, rather than
 * the mark or the header alone, which a request can start with too. A pasted digest with anything added no longer
 * matches its checksum, so it is read as a request.
 */
const ownDigestBody = (text: string): string | null => {
  const t = text.trim();
  if (!t.startsWith(HEADER)) return null;
  const at = t.lastIndexOf(`\n\n${END_OPEN}`);
  if (at < 0) return null;
  const body = t.slice(0, at);
  return t.slice(at + 2) === END(checksum(body)) ? body : null;
};
const isOwnDigest = (text: string): boolean => ownDigestBody(text) !== null;

/** The engine's summary is kept whole as the previous summary; a digest this module wrote is taken apart. */
const isSummary = (m: DigestMessage): boolean => m.role === 'user' && (m.text.trimStart().startsWith(CORE_SUMMARY) || isOwnDigest(m.text));

/**
 * The previous summary, the engine's or one this module wrote, opens the conversation: it is looked for only before
 * the first assistant message rather than anywhere, so a request that quotes one later stays a request.
 */
const openingSummary = (messages: readonly DigestMessage[]): number => {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'assistant') return -1;
    if (isSummary(messages[i]!)) return i;
  }
  return -1;
};

/** The person's words in a user message, '' when there are none: engine-added blocks and the caveat cut out. */
const requestText = (m: DigestMessage): string =>
  m.role === 'user' && (m.toolResults ?? []).length === 0 ? withoutInjected(m.text).split(CAVEAT).join('').trim() : '';

const toolUseIds = (m: DigestMessage): string[] => (m.role === 'assistant' ? m.toolUses.flatMap((u) => (u.tool_use_id ? [u.tool_use_id] : [])) : []);

/**
 * The start moved back until every tool_result from `start` on answers a tool_use from `start` on, or null when a result
 * answers no earlier use at all. Parallel calls can sit in separate assistant rows ahead of one row of results.
 *
 * One pass down from the end rather than a rescan of the tail per move: results that arrive a few calls late each pull
 * the start back by one, and a rescan per move is quadratic in a long run of them.
 */
const paired = (messages: readonly DigestMessage[], start: number): number | null => {
  const useAt = new Map<string, number>();
  messages.forEach((m, i) => {
    for (const id of toolUseIds(m)) if (!useAt.has(id)) useAt.set(id, i);
  });
  let s = start;
  for (let i = messages.length - 1; i >= s; i--) {
    for (const r of messages[i]!.toolResults ?? []) {
      if (!r.tool_use_id) continue;
      const at = useAt.get(r.tool_use_id);
      if (at === undefined) return null;
      if (at < s) s = at;
    }
  }
  return s;
};

/** Index of the first message holding a tool_use that no result anywhere answers yet (a call still in flight), or -1. */
const firstPending = (messages: readonly DigestMessage[]): number => {
  const answered = new Set(messages.flatMap((m) => (m.toolResults ?? []).flatMap((r) => (r.tool_use_id ? [r.tool_use_id] : []))));
  return messages.findIndex((m) => toolUseIds(m).some((id) => !answered.has(id)));
};

type Boundary = { ok: true; start: number } | { ok: false; reason: DigestFallback };

/**
 * The tail starts at an assistant message and holds both halves of every tool exchange in it, so the digest (a user
 * message) is followed by an assistant one and no tool_result is orphaned. It always holds the last assistant message
 * and what follows it (often the large result that crossed the threshold) and every call still in flight, up to twice
 * the budget, and grows back within its share; past that, or when a result's call cannot be found, the compaction is
 * left to the engine.
 */
const tailStart = (messages: readonly DigestMessage[], tailBudget: number, budget: number): Boundary => {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant <= 0) return { ok: false, reason: 'nothing_to_compact' };
  // A call still in flight stays in the tail, so the result that arrives later has its call.
  const pending = firstPending(messages);
  const floor = paired(messages, pending >= 0 ? Math.min(pending, lastAssistant) : lastAssistant);
  if (floor === null) return { ok: false, reason: 'unpaired_result' };
  if (floor === 0) return { ok: false, reason: 'nothing_to_compact' };
  let used = messages.slice(floor).reduce((n, m) => n + messageChars(m), 0);
  if (used > MINIMAL_TAIL_BUDGETS * budget) return { ok: false, reason: pending >= 0 && pending < lastAssistant ? 'pending_call' : 'tail_too_large' };
  // Growing back one message at a time: `open` holds the results in the grown tail whose call it does not hold yet, so a
  // start is taken only where it is empty.
  const uses = new Set(messages.slice(floor).flatMap(toolUseIds));
  const open = new Set<string>();
  let start = floor;
  for (let i = floor - 1; i >= 1; i--) {
    const m = messages[i]!;
    used += messageChars(m);
    if (used > tailBudget) break;
    for (const id of toolUseIds(m)) {
      uses.add(id);
      open.delete(id);
    }
    for (const r of m.toolResults ?? []) if (r.tool_use_id && !uses.has(r.tool_use_id)) open.add(r.tool_use_id);
    if (m.role === 'assistant' && open.size === 0) start = i;
  }
  return { ok: true, start };
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

/**
 * A content line that could read as a section heading or a request marker is indented by one space, so a digest parses
 * back into the parts it was built from whatever the requests and results say. Idempotent: an indented line no longer
 * matches.
 */
const escapeLines = (s: string): string => s.replace(/^(?=## |▸ )/gm, ' ');

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
  const body = ownDigestBody(text);
  if (body === null) return { summary: text.trim(), requests: [], steps: [] };
  // A heading is a whole line: content lines that could read as one were indented when written.
  const heads = [SECTION.summary, SECTION.requests, SECTION.steps];
  const bounds = heads.map((h) => new RegExp(`^${h.replace(/[()]/g, '\\$&')}[ \\t]*$`, 'm').exec(body));
  const part = (k: number): string => {
    const at = bounds[k];
    if (!at) return '';
    const end = bounds.slice(k + 1).find((b) => b && b.index > at.index);
    return body.slice(at.index + at[0].length, end ? end.index : body.length);
  };
  const requests = part(1).trim();
  return {
    summary: part(0).trim(),
    // Split on the marker exactly: an escaped content line starts with a space and is not a new request.
    requests: requests ? requests.replace(/^▸ /, '').split(`\n${REQUEST_PREFIX}`).map((r) => r.trimEnd()) : [],
    steps: part(2).split('\n').filter((l) => l.trim() !== ''),
  };
};

/**
 * The line a kept tail that ends in tool results closes with. The engine appends the session's re-attached instructions
 * and context (CLAUDE.md files, reminders) after the last message a hook hands up, and joins text that follows a tool
 * result into that result (host 2.1.283), so behind such a tail they read as the tool's output: a model took the
 * owner's CLAUDE.md there for injected text and stopped. A built message puts its text after its tool results, and the
 * engine appends after a closing text block rather than into it, so they arrive after this line, outside the results.
 */
export const CLOSING = `${DIGEST_MARK} End of the kept messages. What the engine attaches after this line (CLAUDE.md files, reminders) is this session's own context, re-attached as at its start, not part of the tool results above.`;

type BuiltMessage = {
  role: 'user';
  text: string;
  toolUses: [];
  toolResults?: Array<{ tool_use_id: string; text: string; isError: boolean }>;
};

/**
 * The tools whose results hold text alone, so a result rebuilt from its text is the result the model read. A Read is
 * one unless its path is an image, a PDF or a notebook, which come back as image or document blocks, beside text or
 * alone. Any other tool, an MCP tool among them, may return media, and a last result from one is left to the engine.
 */
const TEXT_TOOLS = new Set([
  'Agent', 'AskUserQuestion', 'Bash', 'BashOutput', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'Glob', 'Grep', 'KillShell',
  'ListAgents', 'Monitor', 'MultiEdit', 'NotebookEdit', 'Read', 'SendMessage', 'Skill', 'SubagentHandback', 'Task',
  'TaskOutput', 'TaskStop', 'TodoWrite', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write',
]);
const MEDIA_PATH = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|avif|svg|pdf|ipynb)$/i;
const textOnly = (u: DigestToolUse): boolean => TEXT_TOOLS.has(u.tool) && !(u.tool === 'Read' && MEDIA_PATH.test(String(u.input.file_path ?? '')));

/** The last message when it answers calls: those results, carried whole as text, and then the closing line. */
const closesWithResults = (m: DigestMessage | undefined): boolean => m?.role === 'user' && (m.toolResults ?? []).length > 0;
const closed = (m: DigestMessage): BuiltMessage => ({
  role: 'user',
  text: m.text.trim() ? `${m.text}\n\n${CLOSING}` : CLOSING,
  toolUses: [],
  toolResults: (m.toolResults ?? []).map((r) => ({ tool_use_id: r.tool_use_id!, text: r.text, isError: r.isError === true })),
});

/**
 * The conversation after the compaction: the digest as a built user message, then the kept tail as it came, except a
 * last message that answers calls, which is handed up rebuilt with the closing line after its results.
 */
export const assemble = <M extends DigestMessage>(messages: readonly M[], r: DigestResult): Array<M | BuiltMessage> => {
  const tail: Array<M | BuiltMessage> = messages.slice(r.start);
  const last = messages[messages.length - 1];
  if (closesWithResults(last) && tail.length > 0) tail[tail.length - 1] = closed(last!);
  return [{ role: 'user', text: r.digest, toolUses: [] }, ...tail];
};

export const buildDigest = (messages: readonly DigestMessage[], options: DigestOptions): DigestOutcome => {
  const budget = options.budgetChars;
  // The last results are rebuilt from their text, which holds no image or document: one that has no text or no id to
  // answer, or that answers a call to a tool that may return media, is left to the engine rather than handed up without
  // it. A result that answers no call at all is the pairing's to refuse (unpaired_result).
  const last = messages[messages.length - 1];
  const closes = closesWithResults(last);
  if (closes) {
    const uses = new Map(messages.flatMap((m) => (m.role === 'assistant' ? m.toolUses.map((u) => [u.tool_use_id, u] as const) : [])));
    const opaque = (r: { text: string; tool_use_id?: string }): boolean => {
      const u = r.tool_use_id ? uses.get(r.tool_use_id) : undefined;
      return !r.text || !r.tool_use_id || (u !== undefined && !textOnly(u));
    };
    if (last!.toolResults!.some(opaque)) return { ok: false, reason: 'opaque_result' };
  }
  const boundary = tailStart(messages, Math.floor(budget * TAIL_SHARE), budget);
  if (!boundary.ok) return boundary;
  const start = boundary.start;
  const head = messages.slice(0, start);
  const tail = messages.slice(start);
  const tailChars = tail.reduce((n, m) => n + messageChars(m), 0) + (closes ? CLOSING.length + 2 : 0);

  // The message itself, headings, separators and the checksum line are paid for up front; each piece pays for its own
  // prefix and line break.
  const frame = MESSAGE_OVERHEAD + HEADER.length + Object.values(SECTION).reduce((n, h) => n + h.length + 3, 0) + END_LENGTH;
  let left = Math.max(budget - tailChars, Math.floor(budget * DIGEST_FLOOR)) - frame;
  const take = (text: string, cap: number, overhead: number, headShare?: number): string => {
    const room = Math.min(cap, left - overhead);
    if (room <= 0) return '';
    const e = escapeLines(text);
    const t = headShare === undefined ? clip(e, room) : clipMiddle(e, room, headShare);
    left -= t.length + overhead;
    return t;
  };

  const summaryAt = openingSummary(head);
  const prior: Carried = summaryAt >= 0 ? carried(head[summaryAt]!.text) : { summary: '', requests: [], steps: [] };
  // Requests, the carried ones first in time. The newest is taken before the previous summary rather than after it, so
  // a long summary cannot crowd it out; the summary then gets at most half of what is left, and earlier requests follow.
  const asked: Piece[] = [
    ...prior.requests.map((text, k) => ({ at: k - prior.requests.length, sub: 0, text })),
    ...head.flatMap((m, i) => {
      const text = i !== summaryAt ? requestText(m) : '';
      return text ? [{ at: i, sub: 0, text }] : [];
    }),
  ];
  // A long request or summary loses its middle rather than its end: an instruction is often the last line of a request,
  // and the engine's summary ends with the current work and the next step.
  const requests: Piece[] = [];
  const ask = (p: Piece, cap: number): void => {
    const t = take(p.text, cap, REQUEST_PREFIX.length + 1, REQUEST_HEAD_SHARE);
    if (t) requests.push({ ...p, text: t });
  };
  const newestFirst = [...asked].reverse();
  if (newestFirst[0]) ask(newestFirst[0], LAST_REQUEST_CHARS);
  const summary = take(prior.summary, Math.min(Math.floor(budget * SUMMARY_SHARE), Math.floor(left / 2)), 0, SUMMARY_HEAD_SHARE);
  for (const p of newestFirst.slice(1)) ask(p, REQUEST_CHARS);

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
  const body = sections.join('\n\n');
  const digest = `${body}\n\n${END(checksum(body))}`;
  const replaced = messages.reduce((n, m) => n + messageChars(m), 0);
  if (MESSAGE_OVERHEAD + digest.length + tailChars > RELIEF * replaced) return { ok: false, reason: 'no_relief' };

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
