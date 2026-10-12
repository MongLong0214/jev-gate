import { runChecker } from './_lib.mjs';
import { testMentions, throwsExactly } from './_episode.mjs';

await runChecker(
  ['module_loads', 'accepts_duration_syntax', 'allows_exactly_one_hour', 'too_long_names_formatted_value', 'zero_rejected', 'bad_syntax_is_type_error', 'timeout_test_added', 'test_suite_passes'],
  async ({ evalDir, check, importModule, runTests }) => {
    let cli;
    await check('module_loads', async () => {
      cli = await importModule('src/cli-options.mjs');
      return typeof cli.parseTimeoutOption === 'function';
    });
    if (!cli) return;
    const p = (v) => cli.parseTimeoutOption(v);
    await check('accepts_duration_syntax', () => p('45m') === 2_700_000 && p('1500ms') === 1500 && p('2m15s') === 135_000);
    await check('allows_exactly_one_hour', () => p('1h') === 3_600_000 && p('59m59s') === 3_599_000);
    await check('too_long_names_formatted_value', () =>
      throwsExactly(() => p('1h30m'), RangeError, 'timeout too long: 1h30m') && throwsExactly(() => p('61m'), RangeError, 'timeout too long: 1h1m') && throwsExactly(() => p('3600001ms'), RangeError, 'timeout too long: 1h1ms'));
    await check('zero_rejected', () => throwsExactly(() => p('0s'), RangeError, 'timeout must be positive'));
    await check('bad_syntax_is_type_error', () => ['soon', '30m1h', ''].every((v) => {
      try {
        p(v);
        return false;
      } catch (err) {
        return err instanceof TypeError && err.message.startsWith('invalid duration:');
      }
    }));
    await check('timeout_test_added', () => testMentions(evalDir, /parseTimeoutOption/));
    await check('test_suite_passes', () => runTests());
  },
);
