import { describe, expect, test, tier } from 'claude-code/testing';

tier('user');

describe('register', () => {
  test('off by default: a spawn reaches the engine unchanged and nothing is fetched', async ($, on) => {
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
