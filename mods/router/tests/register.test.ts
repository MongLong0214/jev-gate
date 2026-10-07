import { describe, expect, mock, test, tier } from 'claude-code/testing';

tier('user');

test('child tool steps use fresh assessments in the real host engine', async ($, on) => {
  mock.env(on, { TYPESAFE_API_KEY: 'sk-router-testonlynotakey' });
  mock.clock(on);
  on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292' } }));
  on('session.id', () => ({ value: 'child-fixture' }));
  on('settings.read', () => ({ value: { effortLevel: 'high' } }));
  on('fs.exists', () => ({ value: false }));
  const logs: string[] = [];
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined }; });
  const contexts: Array<string | undefined> = [];
  on('session.messages', ($, e) => {
    contexts.push(e.agentId);
    return { value: [{ role: 'assistant', text: 'PRIVATE RESULT', toolUses: [{ tool_use_id: 'read', tool: 'Read', input: {}, text: 'PRIVATE SOURCE' }] }] };
  });
  let phase = 0, calls = 0;
  const sent: Array<{ model: string; effort?: string | number }> = [];
  on('http.fetch', ($, e) => {
    calls++;
    const body = JSON.parse(e.init?.body ?? '{}');
    expect(e.init?.body).not.toContain('PRIVATE');
    const target = phase === 0 ? '__keep__' : phase === 1 ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
    const answers = Object.fromEntries(Object.entries(body.questions).map(([name, raw]) => {
      const q = raw as { type: string; criteria: string[] | Record<string, string> };
      if (q.type === 'choice') {
        const value = name === 'model' ? target : name === 'control' ? 'task_clear' : 'ordinary';
        return [name, { type: 'choice', choice: value, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === value ? 1 : 0])) }];
      }
      const levels = q.criteria as string[];
      const at = levels.findIndex(s => s.startsWith(phase === 1 ? 'Light reasoning' : 'Strong reasoning'));
      return [name, { type: 'score', score: at, confidence: 1, probabilities: Object.fromEntries(levels.map((_, i) => [i, i === at ? 1 : 0])) }];
    }));
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: body.model, answers }) } };
  });
  on('agent.spawn', () => ({ agentId: 'child', model: 'claude-opus-5-5' }));
  on('agent.offer', () => ({ isOffered: true }));
  on('turn.step', async function* ($, e) {
    sent.push({ model: e.model, ...(e.effort !== undefined ? { effort: e.effort } : {}) });
    return { turnId: e.turnId, index: e.index, answer: 'fixture', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  await $.agent.offer({ agent: 'general-purpose', description: 'general purpose', source: 'built-in', provider: { plugin: 'engine', tier: 'core' } });
  await $.agent.spawn({ tool_use_id: 'spawn-child', prompt: 'Find the failing test and repair it.', description: 'repair test', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false });
  expect(calls).toBe(1);
  for (phase = 0; phase < 3; phase++) {
    const stream = $.turn.step({ agentId: 'child', turnId: 'child-turn', index: phase, model: 'claude-opus-5-5', effort: 'high', messageCount: phase + 1 });
    while (!(await stream.next()).done) { /* preserve the host stream */ }
    expect({ calls, logs: calls === phase + 1 ? [] : logs, sent: calls === phase + 1 ? [] : sent }).toEqual({ calls: phase + 1, logs: [], sent: [] });
  }
  expect(sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }, { model: 'claude-sonnet-5-5', effort: 'low' }, { model: 'claude-opus-5-5', effort: 'high' }]);
  expect(contexts).toEqual(['child', 'child']);
});

describe('register', () => {
  test('without a key: a spawn reaches the engine unchanged and nothing is fetched', async ($, on) => {
    const fetched: string[] = [];
    const spawned: Array<string | undefined> = [];
    on('http.fetch', ($, e) => {
      fetched.push(e.url);
      throw new Error('no request expected');
    });
    on('agent.spawn', ($, e) => {
      spawned.push(e.model);
      return { model: 'claude-opus-5-5' };
    });

    const result = await $.agent.spawn({
      tool_use_id: 'toolu_1',
      prompt: 'List the files under src/.',
      description: 'list files',
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    });

    expect(result).toEqual({ model: 'claude-opus-5-5' });
    expect(spawned).toEqual([undefined]);
    expect(fetched).toEqual([]);
  });
});

// These dispatch the installed Function Hooks through the real host engine with a scripted HTTP/model bottom.
for (const mode of ['keep', 'effort', 'model', 'both'] as const) {
  test(`root request and later tool steps use one pair assessment: ${mode}`, async ($, on) => {
    mock.env(on, { TYPESAFE_API_KEY: 'sk-router-testonlynotakey' });
    mock.clock(on);
    on('session.version', () => ({ value: { version: '2.1.287', base: '2.1.287' } }));
    on('session.id', () => ({ value: 'root-fixture' }));
    on('settings.read', () => ({ value: { effortLevel: 'high' } }));
    on('fs.exists', () => ({ value: false }));
    on('ui.log', () => ({ value: undefined }));
    const sent: Array<{ model: string; effort?: string | number }> = [];
    let calls = 0;
    on('http.fetch', ($, e) => {
      calls++;
      const body = JSON.parse(e.init?.body ?? '{}');
      const answers = Object.fromEntries(Object.entries(body.questions).map(([name, raw]) => {
        const q = raw as { type: string; instructions: string; criteria: string[] | Record<string, string> };
        if (q.type === 'choice') {
          const value = name === 'model' ? mode === 'model' || mode === 'both' ? 'claude-opus-5-5' : '__keep__' : name === 'control' ? 'task_clear' : 'ordinary';
          return [name, { type: 'choice', choice: value, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === value ? 1 : 0])) }];
        }
        const levels = q.criteria as string[];
        const target = mode === 'both' && q.instructions.includes('IF using model claude-opus-5-5,') ? levels.length - 1 : mode === 'effort' ? 0 : 2;
        return [name, { type: 'score', score: target, confidence: 1, probabilities: Object.fromEntries(levels.map((_, i) => [i, i === target ? 1 : 0])) }];
      }));
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: body.model, answers }) } };
    });
    on('turn.start', ($, e) => ({ turnId: e.turnId }));
    on('turn.step', async function* ($, e) {
      sent.push({ model: e.model, ...(e.effort !== undefined ? { effort: e.effort } : {}) });
      return { turnId: e.turnId, index: e.index, answer: 'fixture', toolUses: [], stopReason: 'end_turn', usage: null };
    });
    await $.turn.start({ text: 'Implement the clear local fixture.', turnId: 'root' });
    for (const index of [0, 1]) {
      const stream = $.turn.step({ turnId: 'root', index, model: 'claude-sonnet-5', effort: 'high', messageCount: 1 });
      while (!(await stream.next()).done) { /* preserve the host stream */ }
    }
    const expected = { model: mode === 'model' || mode === 'both' ? 'claude-opus-5-5' : 'claude-sonnet-5', effort: mode === 'both' ? 'max' : mode === 'effort' ? 'low' : 'high' };
    expect(sent).toEqual([expected, expected]);
    expect(calls).toBe(1);
  });
}

for (const baselineMode of ['default', 'echo'] as const) {
  test(`three root turns reassess Sonnet, Sonnet, Opus with ${baselineMode} baselines`, async ($, on) => {
    mock.env(on, { TYPESAFE_API_KEY: 'sk-router-testonlynotakey' });
    mock.clock(on);
    on('session.version', () => ({ value: { version: '2.1.287', base: '2.1.287' } }));
    on('session.id', () => ({ value: 'same-root-fixture' }));
    on('settings.read', () => ({ value: { effortLevel: 'high' } }));
    on('fs.exists', () => ({ value: false }));
    on('ui.log', () => ({ value: undefined }));
    let phase = 0; let calls = 0; let children = 0;
    const sent: Array<{ turnId: string; model: string; effort?: string | number }> = [];
    on('agent.spawn', () => { children++; throw new Error('Root routing must not spawn a child'); });
    on('http.fetch', ($, e) => {
      calls++;
      const body = JSON.parse(e.init?.body ?? '{}');
      const target = phase < 2 ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
      const answers = Object.fromEntries(Object.entries(body.questions).map(([name, raw]) => {
        const q = raw as { type: string; criteria: string[] | Record<string, string> };
        if (q.type === 'choice') {
          const value = name === 'model' ? target in q.criteria ? target : '__keep__' : name === 'control' ? 'task_clear' : 'ordinary';
          return [name, { type: 'choice', choice: value, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === value ? 1 : 0])) }];
        }
        const levels = q.criteria as string[];
        const at = levels.findIndex(s => s.startsWith(phase < 2 ? 'Ordinary reasoning' : 'Strong reasoning'));
        return [name, { type: 'score', score: at, confidence: 1, probabilities: Object.fromEntries(levels.map((_, i) => [i, i === at ? 1 : 0])) }];
      }));
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: body.model, answers }) } };
    });
    on('turn.start', ($, e) => ({ turnId: e.turnId }));
    on('turn.complete', () => ({ text: '' }));
    on('turn.step', async function* ($, e) {
      sent.push({ turnId: e.turnId, model: e.model, ...(e.effort !== undefined ? { effort: e.effort } : {}) });
      return { turnId: e.turnId, index: e.index, answer: 'fixture', toolUses: [], stopReason: 'end_turn', usage: null };
    });
    for (phase = 0; phase < 3; phase++) {
      const turnId = `root-turn-${phase}`;
      await $.turn.start({ text: phase < 2 ? 'Find the exact source file.' : 'Diagnose the concurrency failure.', turnId });
      const model = phase === 0 || baselineMode === 'default' ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
      for (const index of [0, 1]) {
        const stream = $.turn.step({ turnId, index, model, effort: phase > 0 && baselineMode === 'echo' ? 'medium' : 'high', messageCount: phase * 2 + 1 });
        while (!(await stream.next()).done) { /* preserve the host stream */ }
      }
      expect(calls).toBe(phase + 1);
      await $.turn.complete({ turnId, reason: 'answer', answer: 'Completed visible fixture answer.', durationMs: 1, isAborted: false });
    }
    expect(sent).toEqual([0, 1, 2].flatMap(i => [0, 1].map(() => ({ turnId: `root-turn-${i}`, model: i < 2 ? 'claude-sonnet-5-5' : 'claude-opus-5-5', effort: i < 2 ? 'medium' : 'high' }))));
    expect(children).toBe(0);
  });
}
