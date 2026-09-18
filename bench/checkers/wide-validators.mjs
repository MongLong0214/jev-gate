import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runChecker, sameKeys } from './_lib.mjs';

/**
 * Twelve independent modules with the same latent defect: an empty array is accepted where at least one entry is
 * required. The outcomes do not depend on each other, which is the shape Gate A is supposed to recognise as
 * orchestrated. Every module is checked on behaviour, and the candidate's own tests must fail against the unfixed
 * source, so "added a test file" is not enough on its own.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BROKEN_SRC = join(HERE, '..', 'fixtures', 'wide-validators', 'src');
const FIELDS = ['email', 'phone', 'postcode', 'country', 'currency', 'locale', 'timezone', 'vat', 'iban', 'swift', 'tax', 'duns'];
const fn = (name) => `validate${name.charAt(0).toUpperCase()}${name.slice(1)}`;

await runChecker(
  ['all_modules_load', 'exports_preserved', 'populated_still_accepted', 'blank_still_rejected', 'missing_still_rejected', 'empty_rejected_everywhere', 'tests_detect_bug', 'test_suite_passes'],
  async ({ check, importModule, runTests, runTestsAgainst }) => {
    const mods = new Map();
    await check('all_modules_load', async () => {
      for (const f of FIELDS) mods.set(f, await importModule(`src/${f}.mjs`));
      return mods.size === FIELDS.length;
    });
    if (mods.size !== FIELDS.length) return;

    await check('exports_preserved', () => FIELDS.every((f) => typeof mods.get(f)[fn(f)] === 'function' && sameKeys(mods.get(f), [fn(f)])));

    // The three behaviours that were already correct must survive the change, in every module.
    await check('populated_still_accepted', () =>
      FIELDS.every((f) => {
        const r = mods.get(f)[fn(f)]({ [`${f}s`]: ['x'] });
        return r.ok === true && r.field === f && r.count === 1;
      }));
    await check('blank_still_rejected', () =>
      FIELDS.every((f) => {
        const r = mods.get(f)[fn(f)]({ [`${f}s`]: ['  '] });
        return r.ok === false && r.field === f && r.reason === 'blank';
      }));
    await check('missing_still_rejected', () =>
      FIELDS.every((f) => {
        const r = mods.get(f)[fn(f)]({});
        return r.ok === false && r.field === f && r.reason === 'missing';
      }));

    // The requested change: an empty list is not a valid section.
    await check('empty_rejected_everywhere', () =>
      FIELDS.every((f) => {
        const r = mods.get(f)[fn(f)]({ [`${f}s`]: [] });
        return r.ok === false && r.field === f && typeof r.reason === 'string' && r.reason.length > 0;
      }));

    await check('tests_detect_bug', () => runTestsAgainst(BROKEN_SRC) === false);
    await check('test_suite_passes', () => runTests());
  },
);
