import { runChecker } from './_lib.mjs';
import { testMentions } from './_episode.mjs';

// The original title permits a 45-char base when cutting at the last dash inside
// the first 50 chars. The suffix then fits without cutting the base again.
const LONG = 'alpha beta gamma delta epsilon zeta eta theta iota kapp';

await runChecker(
  ['module_loads', 'free_title_unchanged', 'smallest_free_number', 'uses_korean_slug_rule', 'suffix_respects_length_at_boundary', 'unique_test_added', 'test_suite_passes'],
  async ({ evalDir, check, importModule, runTests }) => {
    let slug;
    let uniq;
    await check('module_loads', async () => {
      slug = await importModule('src/slugify.mjs');
      uniq = await importModule('src/unique-slug.mjs');
      return typeof slug.slugify === 'function' && typeof uniq.uniqueSlug === 'function';
    });
    if (!slug || !uniq) return;
    const u = (title, taken) => uniq.uniqueSlug(title, new Set(taken));
    await check('free_title_unchanged', () => u('Hello, World!', []) === 'hello-world');
    await check('smallest_free_number', () => u('Hello World', ['hello-world', 'hello-world-2']) === 'hello-world-3' && u('Hello World', ['hello-world', 'hello-world-3']) === 'hello-world-2');
    await check('uses_korean_slug_rule', () => u('안녕 세상', ['안녕-세상']) === '안녕-세상-2');
    await check('suffix_respects_length_at_boundary', () => {
      const examples = [
        [LONG, 'alpha-beta-gamma-delta-epsilon-zeta-eta-theta-2'],
        // Exactly 50 chars before the suffix: this must cut back to the word boundary.
        ['a'.repeat(40) + ' ' + 'b'.repeat(9), 'a'.repeat(40) + '-2'],
        // No word boundary: the task explicitly permits a hard cut.
        ['x'.repeat(55), 'x'.repeat(48) + '-2'],
      ];
      return examples.every(([title, expected]) => u(title, [slug.slugify(title)]) === expected);
    });
    await check('unique_test_added', () => testMentions(evalDir, /uniqueSlug/));
    await check('test_suite_passes', () => runTests());
  },
);
