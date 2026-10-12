import { describe, expect, it } from 'vitest';

import { looksSecret as routerLooksSecret, SECRET_PATTERNS as ROUTER } from '../../mods/router/hooks/secret.ts';
import { looksSecret as sourceLooksSecret, SECRET_PATTERNS as SOURCE } from '../../src/outbound-text.js';

/**
 * The Router cannot import the Node side of the repository, so it carries a copy of the shared credential screen. A
 * copy that drifts screens one feature's outbound text differently from the other's; this keeps them identical.
 */
describe('credential screen parity', () => {
  it('holds the same patterns, in the same order, with the same flags', () => {
    expect(ROUTER.map(String)).toEqual(SOURCE.map(String));
  });

  it('answers the same on the forms both screen and both pass', () => {
    const samples = [
      'curl -H "Authorization: Basic dTpw" host',
      `headers.set("Authorization",\n${' '.repeat(10)}"Basic dTpw");`,
      'postgres://u:%40secret@host/app',
      `Use token sk-${'a'.repeat(24)}testonlynotakey for the call`,
      'headers.set("Authorization", `Bearer ${token}`);',
      'Rename parseRow to parseRecord in src/rows.ts.',
    ];
    for (const s of samples) expect(routerLooksSecret(s), s).toBe(sourceLooksSecret(s));
  });
});
