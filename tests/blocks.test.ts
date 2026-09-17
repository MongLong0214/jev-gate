import { describe, expect, it } from 'vitest';

import { MAX_BLOCKS, splitLossless } from '../src/blocks.js';

const EXAMPLE = '검색 응답이 역순으로 오면 옛 결과가 화면을 덮는 버그를 고쳐줘.\nAPI 응답 형식과 의존성은 바꾸지 마.\n늦은 응답을 재현하는 테스트도 추가해.';

const assertLossless = (prompt: string): ReturnType<typeof splitLossless> => {
  const blocks = splitLossless(prompt);
  expect(blocks.map((b) => b.text).join('')).toBe(prompt);
  let cursor = 0;
  for (const [i, b] of blocks.entries()) {
    expect(b.id).toBe(`u${i + 1}`);
    expect(b.start).toBe(cursor);
    expect(prompt.slice(b.start, b.end)).toBe(b.text);
    cursor = b.end;
  }
  expect(cursor).toBe(prompt.length);
  expect(blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
  return blocks;
};

describe('splitLossless', () => {
  it('splits the spec example into three line blocks', () => {
    const blocks = assertLossless(EXAMPLE);
    expect(blocks.map((b) => b.text)).toEqual(['검색 응답이 역순으로 오면 옛 결과가 화면을 덮는 버그를 고쳐줘.\n', 'API 응답 형식과 의존성은 바꾸지 마.\n', '늦은 응답을 재현하는 테스트도 추가해.']);
  });

  it('is lossless for CRLF, emoji, blank lines, trailing whitespace and leading whitespace', () => {
    for (const p of ['a\r\nb\r\n\r\nc', '🙂 이모지\n\n\n끝 ', '\n\n첫 줄\n둘', 'single', 'x\n', '  \n  ', '', '한글만\r\n', 'tab\tinside\nline2 weird']) {
      assertLossless(p);
    }
  });

  it('keeps a code fence as one block without labels inside', () => {
    const p = 'Fix this:\n```js\nconst a = 1;\n\nconst b = 2;\n```\nThanks';
    const blocks = assertLossless(p);
    expect(blocks.map((b) => b.text)).toEqual(['Fix this:\n', '```js\nconst a = 1;\n\nconst b = 2;\n```\n', 'Thanks']);
  });

  it('extends an unclosed fence to the end and honors tilde fences', () => {
    expect(assertLossless('intro\n~~~\nx\ny').map((b) => b.text)).toEqual(['intro\n', '~~~\nx\ny']);
  });

  it('merges adjacent blocks down to the cap without altering text', () => {
    const p = Array.from({ length: 80 }, (_, i) => `line ${i} ${'x'.repeat(i % 7)}`).join('\n');
    const blocks = assertLossless(p);
    expect(blocks.length).toBe(MAX_BLOCKS);
  });

  it('never splits a fence when merging', () => {
    const fence = '```\n' + Array.from({ length: 30 }, (_, i) => `code ${i}`).join('\n') + '\n```';
    const p = Array.from({ length: 30 }, (_, i) => `prose ${i}`).join('\n') + '\n' + fence + '\nafter';
    const blocks = assertLossless(p);
    const fenceBlock = blocks.find((b) => b.text.includes('code 0'));
    expect(fenceBlock?.text).toContain('code 29\n```');
  });
});
