import { describe, expect, test, tier } from 'claude-code/testing';

tier('user');

describe('register', () => {
  test('off by default: a Bash result is the engine own, unchanged, and nothing is read', async ($, on) => {
    const reads: string[] = [];
    on('fs.read', ($, e) => {
      reads.push(e.path);
      throw new Error('no read expected');
    });
    on('tool.call', { tool: 'Bash' }, () => ({
      result: { stdout: 'engine output', stderr: '', interrupted: false, persistedOutputPath: '/r/tool-results/b1.txt', persistedOutputSize: 40000 },
    }));

    const result = await $.tool.call({ tool: 'Bash', command: 'npx vitest run' });

    expect(result.result).toEqual({ stdout: 'engine output', stderr: '', interrupted: false, persistedOutputPath: '/r/tool-results/b1.txt', persistedOutputSize: 40000 });
    expect(reads).toEqual([]);
  });
});
