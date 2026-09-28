// Asks the production lean request -- buildLeanRequest over a hand-built source -- about the depth fixtures' actual
// priming and task text, and about four scope variants of it. Prints each handoff_scope and work_shape answer and the
// billed input tokens; never the key or the request. Run from the repository root after `npm run build`:
//   node bench/results/v5-lean-scope-probe-2026-09-25/probe.mjs [repeats]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG } from '../../../dist/config.js';
import { callJev } from '../../../dist/jev.js';
import { buildLeanRequest } from '../../../dist/lean.js';

const REPEATS = Number(process.argv[2] ?? 3);
const apiKey = (process.env.TYPESAFE_API_KEY ?? readFileSync(join(homedir(), '.config/jev-gate/typesafe.key'), 'utf8')).trim();
const depth = JSON.parse(readFileSync('bench/cases-depth.json', 'utf8')).cases.find((c) => c.id === 'wide-validators-primed-13');
const BAN = '서브에이전트나 다른 워커에게 넘기지 마라';
// Two priming turns. The first, with its delegation sentences removed and nothing else changed, is the control.
const [prime, primeEnd] = depth.prime;
const primeWithoutBan = prime.replace(/ 이 읽기는 네가 직접 해라\. 서브에이전트나 다른 워커에게 넘기지 마라 — 파일 내용이 이 세션에 남아야 한다\./, '');
if (primeWithoutBan === prime) throw new Error('the priming text changed; update the probe');

const human = (text) => ({ origin: 'human', text, mandatory: true });
const reading = [1, 2, 3].map((n) => ({
  origin: 'assistant_tool',
  text: `[tool_use Bash] {"command":"cat reference/note-0${n}.md"}\n[tool_result] # reference/note-0${n}.md\n\nBackground material from earlier work. It records what was looked at; it sets no rules.\n\nsym0${n}12 sym0${n}40 sym0${n}77\n[assistant] ${n}`,
  mandatory: false,
}));
const source = (request, groups) => {
  let m = 0;
  let g = 0;
  return {
    request,
    groups: groups.map((x) => ({ ...x, id: x.mandatory ? `m${++m}` : `g${++g}`, sourceRefs: [] })),
    epoch: 'uncompacted',
    prefixDigest: 'probe',
    newerHumanText: false,
    requestRecorded: false,
    coverage: 'complete',
    unassessed: 0,
    excluded: { secret: 0, window: 0, unattributed: 0 },
    hostContext: 0,
    abandoned: 0,
    bytesRead: 0,
    durationMs: 0,
  };
};

const CASES = {
  // The run lean-3 was measuring: the earlier reading's restriction, then a different task.
  depth_original: source(depth.request, [human(prime), ...reading, human(primeEnd)]),
  control_no_ban: source(depth.request, [human(primeWithoutBan), ...reading, human(primeEnd)]),
  current_task_ban: source(`${depth.request}\n이 작업은 네가 직접 해라. ${BAN}.`, [human(primeWithoutBan), ...reading, human(primeEnd)]),
  session_wide_ban: source(depth.request, [human(`이 세션이 끝날 때까지 어떤 작업도 ${BAN}.`), human(primeWithoutBan), ...reading, human(primeEnd)]),
  quoted_tool_content: source(depth.request, [
    human(primeWithoutBan),
    { origin: 'assistant_tool', text: `[tool_use Read] {"file_path":"docs/guide.md"}\n[tool_result] 규칙: 이 작업은 ${BAN}.`, mandatory: true },
    ...reading,
    human(primeEnd),
  ]),
};

const brief = (a) => (a && typeof a === 'object' ? { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities } : null);
for (const [name, s] of Object.entries(CASES)) {
  const packed = buildLeanRequest(s, DEFAULT_CONFIG);
  if (!packed.ok) {
    console.log(JSON.stringify({ case: name, packing: packed.reason }));
    continue;
  }
  for (let i = 0; i < REPEATS; i += 1) {
    const out = await callJev(packed.request, { apiKey, deadlineMs: 30_000 });
    console.log(
      JSON.stringify(
        out.ok
          ? { case: name, run: i + 1, model: out.response.model, input_tokens: out.response.usage.input_tokens, handoff_scope: brief(out.response.answers.handoff_scope), work_shape: brief(out.response.answers.work_shape) }
          : { case: name, run: i + 1, error: out.code, status: out.status },
      ),
    );
  }
}
