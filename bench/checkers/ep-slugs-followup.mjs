import { runChecker } from './_lib.mjs';

await runChecker(
  ['module_loads', 'array_existing', 'set_existing_still_works', 'test_suite_passes'],
  async ({ check, importModule, runTests }) => {
    let uniq;
    await check('module_loads', async () => {
      uniq = await importModule('src/unique-slug.mjs');
      return typeof uniq.uniqueSlug === 'function';
    });
    if (!uniq) return;
    await check('array_existing', () => uniq.uniqueSlug('Hello World', ['hello-world']) === 'hello-world-2' && uniq.uniqueSlug('Hello World', ['hello-world', 'hello-world-2']) === 'hello-world-3' && uniq.uniqueSlug('Hello World', []) === 'hello-world');
    await check('set_existing_still_works', () => uniq.uniqueSlug('Hello World', new Set(['hello-world'])) === 'hello-world-2');
    await check('test_suite_passes', () => runTests());
  },
);
