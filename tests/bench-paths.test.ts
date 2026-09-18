import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { copyTree, createExclusiveDir, hashTree, isInside, isSafeId, isSensitiveName, overlaps } from '../src/bench/paths.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-paths-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('safe ids and containment', () => {
  it('accepts single safe components and rejects traversal, separators and absolute paths', () => {
    expect(isSafeId('search-race')).toBe(true);
    expect(isSafeId('A_1')).toBe(true);
    for (const bad of ['../../victim', 'a/b', 'a\\b', '/abs', '.hidden', '-dash', '', 'x'.repeat(65), 'a b']) expect(isSafeId(bad), bad).toBe(false);
  });

  it('isInside uses canonical paths, not string prefixes', () => {
    const parent = join(tmp, 'parent');
    mkdirSync(join(parent, 'child'), { recursive: true });
    mkdirSync(join(tmp, 'parent-sibling'), { recursive: true });
    expect(isInside(parent, join(parent, 'child'))).toBe(true);
    expect(isInside(parent, join(parent, 'new', 'deeper'))).toBe(true);
    expect(isInside(parent, join(tmp, 'parent-sibling'))).toBe(false);
    expect(isInside(parent, join(parent, '..', 'parent-sibling'))).toBe(false);
    expect(overlaps(parent, join(parent, 'child'))).toBe(true);
    expect(overlaps(join(parent, 'child'), parent)).toBe(true);
    expect(overlaps(parent, join(tmp, 'other'))).toBe(false);
  });

  it('createExclusiveDir refuses an existing directory even when empty', () => {
    const d = join(tmp, 'excl');
    createExclusiveDir(d);
    expect(() => createExclusiveDir(d)).toThrow();
  });
});

describe('copyTree', () => {
  it('copies files with exec bits, skips .git/node_modules for fixtures, records symlinks and sensitive names without copying them', () => {
    const src = join(tmp, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    mkdirSync(join(src, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(src, '.git'), { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'A');
    writeFileSync(join(src, 'sub', 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(src, 'sub', 'run.sh'), 0o755);
    writeFileSync(join(src, '.env'), 'SECRET=1');
    writeFileSync(join(src, '.env.example'), 'SECRET=');
    writeFileSync(join(src, 'node_modules', 'x', 'i.js'), '');
    writeFileSync(join(src, '.git', 'HEAD'), 'ref');
    symlinkSync(join(tmp, 'outside'), join(src, 'link'));
    const dst = join(tmp, 'dst');
    const report = copyTree(src, dst, {});
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(dst, '.env.example'), 'utf8')).toBe('SECRET=');
    expect(existsSync(join(dst, '.env'))).toBe(false);
    expect(existsSync(join(dst, 'link'))).toBe(false);
    expect(existsSync(join(dst, 'node_modules'))).toBe(false);
    expect(existsSync(join(dst, '.git'))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(join(dst, 'sub', 'run.sh')).mode & 0o111).not.toBe(0);
    expect(report.files).toBe(3);
    expect(report.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ path: '.env', kind: 'sensitive' }), expect.objectContaining({ path: 'link', kind: 'symlink' })]));
    expect(report.sha256).toBe(hashTree(src, false));
    const dstGit = join(tmp, 'dst-git');
    copyTree(src, dstGit, { keepGit: true });
    expect(readFileSync(join(dstGit, '.git', 'HEAD'), 'utf8')).toBe('ref');
  });

  it('strictSymlinks turns a source symlink into a preparation error', () => {
    const src = join(tmp, 'strict');
    mkdirSync(src, { recursive: true });
    symlinkSync(tmp, join(src, 'escape'));
    expect(() => copyTree(src, join(tmp, 'strict-out'), { strictSymlinks: true })).toThrow(/unsupported symlink/);
  });

  it('refuses overlapping source/destination and destinations under forbidden roots, and never touches a sentinel outside', () => {
    const src = join(tmp, 'ov');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'f'), 'x');
    const sentinel = join(tmp, 'victim.txt');
    writeFileSync(sentinel, 'PRESERVE ME');
    expect(() => copyTree(src, join(src, 'inner'), {})).toThrow(/overlap/);
    // A forbidden root inside the source is skipped, not entered.
    mkdirSync(join(src, 'run-out'), { recursive: true });
    writeFileSync(join(src, 'run-out', 'cell.json'), '{}');
    const rep = copyTree(src, join(tmp, 'ov-out'), { forbiddenRoots: [join(src, 'run-out')] });
    expect(rep.files).toBe(1);
    expect(existsSync(join(tmp, 'ov-out', 'run-out'))).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('PRESERVE ME');
    expect(isSensitiveName('id_rsa')).toBe(true);
    expect(isSensitiveName('server.key')).toBe(true);
    expect(isSensitiveName('README.md')).toBe(false);
  });
});
