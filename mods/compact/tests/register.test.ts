import { describe, expect, test, tier } from 'claude-code/testing';

tier('user');

describe('register', () => {
  test('off by default: a compaction is the engine own, unchanged', async ($, on) => {
    const seen: string[] = [];
    on('session.compact', ($, e) => {
      seen.push(e.trigger);
      return { messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] };
    });

    const messages = [
      { role: 'user' as const, text: 'Rename parseRow.', toolUses: [] },
      { role: 'assistant' as const, text: 'Renamed.', toolUses: [] },
      { role: 'user' as const, text: 'Thanks.', toolUses: [] },
      { role: 'assistant' as const, text: 'Done.', toolUses: [] },
    ];
    const result = await $.session.compact({ trigger: 'auto', messages });

    expect(seen).toEqual(['auto']);
    expect(result).toEqual({ messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] });
  });
});
