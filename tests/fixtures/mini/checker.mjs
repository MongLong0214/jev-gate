import { runChecker } from '../../../bench/checkers/_lib.mjs';

await runChecker(['module_loads', 'answer_is_42'], async ({ check, importModule }) => {
  let mod;
  await check('module_loads', async () => {
    mod = await importModule('src/answer.mjs');
    return typeof mod.answer === 'function';
  });
  if (!mod) return;
  await check('answer_is_42', () => mod.answer() === 42);
});
