import { describe, expect, it } from 'vitest';
import { readOnlyCommand, writeTargets } from '../../src/codex/write-scope.js';

describe('E1: Git read option allowlist', () => {
  it.each([
    `git grep --no-textconv --open-files-in-pager='printf PAGER_EXECUTED' pattern`,
    `git grep --no-textconv -O'printf PAGER_EXECUTED' pattern`,
    'git grep --no-textconv -Oprintf pattern',
    `git grep --no-textconv --open-files-in='printf PAGER_EXECUTED' pattern`,
    `git grep --no-textconv -nO'printf PAGER_EXECUTED' pattern`,
  ])('rejects pager execution and its prefix/cluster forms: %s', command => {
    expect(readOnlyCommand(command)).toBe(false);
    expect(writeTargets('/unrelated', 'exec_command', { cmd: command, workdir: '/unrelated' })).toEqual(['/']);
  });

  it.each(['log', 'diff', 'show'].flatMap(sub => ['--output=result', '--output result', '--out=result', '-oresult', '-o result', '-poresult', '-Mporesult', '-Cporesult']
    .map(option => `git ${sub} --no-textconv --no-ext-diff ${option} HEAD`)))('rejects output writers and unlisted short clusters: %s', command => {
    expect(readOnlyCommand(command)).toBe(false);
    expect(writeTargets('/unrelated', 'Bash', { command })).toEqual(['/']);
  });

  it.each([
    `git -c core.pager='printf PAGER_EXECUTED' log --no-textconv --no-ext-diff`,
    `git -ccore.pager='printf PAGER_EXECUTED' log --no-textconv --no-ext-diff`,
    'git --config-env=core.pager=PAGER_COMMAND status', 'git --config-env core.pager=PAGER_COMMAND status',
    'git --exec-path=/synthetic status', 'git --exec-path /synthetic status',
    'git --git-dir=.git status', 'git --work-tree=. status', 'git -p status', 'git --paginate status',
    `GIT_PAGER='printf PAGER_EXECUTED' git log --no-textconv --no-ext-diff`,
    'GIT_EXEC_PATH=/synthetic git status', 'GIT_CONFIG_GLOBAL=synthetic.config git status',
    'git --unknown-global status', 'git -C', 'git constructor --unknown-read-option',
    'git __proto__ --unknown-read-option', 'git toString --unknown-read-option',
  ])('rejects program/config/pager overrides and unknown Git forms: %s', command => {
    expect(readOnlyCommand(command)).toBe(false);
    expect(writeTargets('/unrelated', 'exec_command', { cmd: command })).toEqual(['/']);
  });

  it.each([
    'status', 'diff --no-textconv --no-ext-diff', 'log --no-textconv --no-ext-diff', 'show --no-textconv --no-ext-diff',
    'rev-parse', 'ls-files', 'blame --no-textconv', 'grep --no-textconv', 'cat-file', 'merge-base', 'describe',
    'branch --show-current', 'remote -v', 'remote get-url', 'config --get', 'config --list', 'config get', 'config list',
  ])('rejects an unknown option on each read form: git %s', form => {
    const command = `git ${form} --unknown-read-option`;
    expect(readOnlyCommand(command)).toBe(false);
    expect(writeTargets('/unrelated', 'exec_command', { cmd: command })).toEqual(['/']);
  });

  it.each([
    'git status --short', 'git status --porcelain=v1 -sb', 'git status -u', 'git status -uall',
    'git diff --no-textconv --no-ext-diff --stat main...HEAD', 'git diff --no-textconv --no-ext-diff',
    'git diff --no-textconv --no-ext-diff --stat=80,40 -U5 -- src', 'git diff --no-textconv --no-ext-diff -M --stat-width=80',
    'git log --no-textconv --no-ext-diff --oneline -5', 'git log --no-textconv --no-ext-diff -n 5 --format=%H',
    'git show --no-textconv --no-ext-diff --stat HEAD',
    'git grep --no-textconv -n pattern -- src', 'git grep --no-textconv -nF -e pattern -- src', 'git grep --no-textconv --color=never pattern',
    'git blame --no-textconv -L 1,5 file', 'git blame --no-textconv -L1,5 file',
    'git rev-parse --short HEAD', 'git rev-parse --short=8 HEAD', 'git rev-parse --show-toplevel',
    'git ls-files', 'git ls-files --stage -z -- src', 'git cat-file -p HEAD', 'git cat-file --batch-check="%(objectname)"',
    'git merge-base HEAD main', 'git merge-base --is-ancestor main HEAD', 'git describe --tags --always',
    'git branch --show-current', 'git remote -v', 'git remote --verbose', 'git remote get-url --all origin',
    'git config --get user.name', 'git config --get-all remote.origin.url', 'git config --get-regexp ^remote',
    'git config --list --show-origin', 'git config -l', 'git config get --all user.name', 'git config list',
    'git -C /synthetic --no-pager status --short', 'git -P -C /synthetic rev-parse HEAD', 'git --version',
    'git diff --no-textconv --no-ext-diff -- --output=file',
  ])('preserves ordinary reads with callback disabling where required: %s', command => {
    expect(readOnlyCommand(command)).toBe(true);
    expect(writeTargets('/unrelated', 'exec_command', { cmd: command })).toBeNull();
  });

  it.each([
    'git diff --stat main...HEAD', 'git log --oneline -5', 'git show --stat HEAD', 'git grep -n pattern -- src',
    'git blame -L 1,5 file', 'git diff --no-textconv --no-ext-diff --no-no-textconv',
    'git diff --no-textconv --no-ext-diff --no-no-ext-diff', 'git log --no-textconv --no-ext-diff --format=%G?',
    'git show --no-textconv --no-ext-diff --pretty=format:%GS', 'git cat-file --filters HEAD:file',
    'git diff --no-textconv --no-ext-diff --textc', 'git grep --no-textconv --no-no-textconv pattern',
    'git diff --src-prefix --no-textconv --no-ext-diff', 'git grep --no-textconv --regexp --open-files-in-pager=printf',
  ])('preserves callback guards and rejects option/value ambiguity: %s', command => {
    expect(readOnlyCommand(command)).toBe(false);
    expect(writeTargets('/unrelated', 'Bash', { command })).toEqual(['/']);
  });
});
