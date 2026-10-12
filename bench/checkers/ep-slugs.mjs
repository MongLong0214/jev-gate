import { runChecker } from './_lib.mjs';
import { testMentions } from './_episode.mjs';

// Its slug runs past 50 with a boundary exactly at 50, so the base is 50 long and the suffixed form has to cut deeper.
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
      const base = slug.slugify(LONG);
      const r = u(LONG, [base]);
      const head = r.slice(0, -2);
      // The base is itself cut at a boundary; with "-2" the head must be a prefix of it that ends on a word boundary.
      return r.endsWith('-2') && r.length <= 50 && base.startsWith(head) && base[head.length] === '-' && head.length > 0;
    });
    await check('unique_test_added', () => testMentions(evalDir, /uniqueSlug/));
    await check('test_suite_passes', () => runTests());
  },
);
