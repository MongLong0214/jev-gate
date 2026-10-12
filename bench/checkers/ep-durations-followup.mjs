import { runChecker } from './_lib.mjs';
import { throwsExactly } from './_episode.mjs';

await runChecker(
  ['module_loads', 'bare_number_is_seconds', 'bare_number_limits', 'duration_syntax_still_works', 'test_suite_passes'],
  async ({ check, importModule, runTests }) => {
    let cli;
    await check('module_loads', async () => {
      cli = await importModule('src/cli-options.mjs');
      return typeof cli.parseTimeoutOption === 'function';
    });
    if (!cli) return;
    const p = (v) => cli.parseTimeoutOption(v);
    await check('bare_number_is_seconds', () => p('90') === 90_000 && p('3600') === 3_600_000);
    await check('bare_number_limits', () => throwsExactly(() => p('3601'), RangeError, 'timeout too long: 1h1s') && throwsExactly(() => p('0'), RangeError, 'timeout must be positive'));
    await check('duration_syntax_still_works', () => p('45m') === 2_700_000 && throwsExactly(() => p('1h30m'), RangeError, 'timeout too long: 1h30m'));
    await check('test_suite_passes', () => runTests());
  },
);
