import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  promises as fsp,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScopeError } from '../../../src/plugins/types';
import {
  _validateLeafForTest,
  resolveForRead,
  resolveForWrite,
} from '../services/path-resolve.helper';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'continuo-path-'));
  tempRoots.push(dir);
  return dir;
}

function expectLeafReject(leaf: string, reason: string): void {
  expect(() => _validateLeafForTest(leaf, `/tmp/${leaf}`)).toThrow(ScopeError);
  expect(() => _validateLeafForTest(leaf, `/tmp/${leaf}`)).toThrow(reason);
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('path-resolve.helper', () => {
  it('T20.A happy resolveForRead returns canonical realpath', async () => {
    const dir = makeTempDir();
    const file = join(dir, randomBytes(8).toString('hex'));
    writeFileSync(file, 'ok');

    await expect(resolveForRead(file)).resolves.toEqual({
      canonical: realpathSync(file),
    });
  });

  it('T20.B resolveForRead ENOENT throws target does not exist', async () => {
    const missing = join(tmpdir(), `missing-${randomBytes(8).toString('hex')}`);

    await expect(resolveForRead(missing)).rejects.toThrow(ScopeError);
    await expect(resolveForRead(missing)).rejects.toThrow('target does not exist');
  });

  it('T20.C happy resolveForWrite returns parent canonical and leaf', async () => {
    const dir = makeTempDir();

    await expect(resolveForWrite(join(dir, 'newfile.txt'))).resolves.toEqual({
      parentCanonical: realpathSync(dir),
      leaf: 'newfile.txt',
    });
  });

  it('T20.D resolveForWrite parent missing throws parent missing', async () => {
    await expect(
      resolveForWrite('/definitely/nonexistent/dir/file'),
    ).rejects.toThrow(ScopeError);
    await expect(
      resolveForWrite('/definitely/nonexistent/dir/file'),
    ).rejects.toThrow('parent missing');
  });

  it('T20.E resolveForWrite symlink leaf rejected', async () => {
    const dir = makeTempDir();
    const sym = join(dir, 'sym');
    symlinkSync('/somewhere', sym);

    await expect(resolveForWrite(sym)).rejects.toThrow(ScopeError);
    await expect(resolveForWrite(sym)).rejects.toThrow('symlink leaf rejected');
  });

  // 数据安全(codex 复查 P1):symlink-leaf 守卫的 lstat(leaf) 非 ENOENT 错误此前被吞 →
  // fail-open 绕过「symlink leaf rejected」。EACCES/EIO 等「无法确认 leaf」须抛 ScopeError。
  it('T20.E2 resolveForWrite:leaf lstat EACCES → 抛(不 fail-open)', async () => {
    const dir = makeTempDir();
    const realLstat = fsp.lstat;
    const spy = vi
      .spyOn(fsp, 'lstat')
      .mockImplementation(async (p: Parameters<typeof realLstat>[0]) => {
        if (String(p).endsWith('leaf.txt')) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return realLstat(p);
      });
    await expect(resolveForWrite(join(dir, 'leaf.txt'))).rejects.toThrow(
      ScopeError,
    );
    await expect(resolveForWrite(join(dir, 'leaf.txt'))).rejects.toThrow(
      'cannot stat write leaf',
    );
    spy.mockRestore();
  });

  it('T20.F ~ expansion resolves homedir realpath', async () => {
    const result = await resolveForRead('~');

    expect(result.canonical).toBe(realpathSync(homedir()));
    expect(result.canonical).not.toContain('~');
    expect(
      result.canonical.startsWith('/Users/') ||
        result.canonical.startsWith('/home/'),
    ).toBe(true);
  });

  it('T20.a rejects empty leaf', () => {
    expectLeafReject('', 'empty leaf');
  });

  it('T20.b rejects leaf "."', () => {
    expectLeafReject('.', 'leaf is "."');
  });

  it('T20.c rejects leaf ".."', () => {
    expectLeafReject('..', 'leaf is ".."');
  });

  it('T20.d rejects leaf containing backslash separator', () => {
    expectLeafReject('foo\\bar', 'leaf contains path separator');
  });

  it('T20.e rejects leaf containing ~', () => {
    expectLeafReject('foo~bar', 'leaf contains ~');
  });

  it('T20.f rejects leaf containing ..', () => {
    expectLeafReject('foo..bar', 'leaf contains ..');
  });

  it('T20.g rejects leaf containing control char', () => {
    expectLeafReject('foo\x01bar', 'leaf contains control char');
  });

  it('T20.h rejects leaf containing null byte as control char', () => {
    expectLeafReject('foo\x00bar', 'leaf contains control char');
  });

  it('T20.i rejects leaf longer than Windows MAX_PATH', () => {
    expectLeafReject('a'.repeat(261), 'leaf exceeds 260 chars');
  });

  it('T20.j rejects leaf containing Windows ADS colon', () => {
    expectLeafReject('foo:bar', 'leaf contains :');
  });

  it('T20.k rejects Windows reserved name CON', () => {
    expectLeafReject('CON', 'leaf is Windows reserved');
  });

  it('T20.k rejects Windows reserved name con', () => {
    expectLeafReject('con', 'leaf is Windows reserved');
  });

  it('T20.k rejects Windows reserved name Con.txt', () => {
    expectLeafReject('Con.txt', 'leaf is Windows reserved');
  });

  it('T20.l rejects leaf trailing dot', () => {
    expectLeafReject('foo.', 'trailing dot or space');
  });

  it('T20.m rejects leaf trailing space', () => {
    expectLeafReject('foo ', 'trailing dot or space');
  });

  it('T20.n rejects NFD leaf', () => {
    expectLeafReject('cafe\u0301', 'not NFC-normalized');
  });

  it('T20.o rejects NTFS 8.3 alias PROGRA~1', () => {
    expectLeafReject('PROGRA~1', 'NTFS 8.3 short-name');
  });

  it('T20.p rejects NTFS 8.3 alias foo~9.txt', () => {
    expectLeafReject('foo~9.txt', 'NTFS 8.3 short-name');
  });

  it('T20.q accepts happy leaf valid-file_name.txt', () => {
    expect(
      _validateLeafForTest('valid-file_name.txt', '/tmp/valid-file_name.txt'),
    ).toBeUndefined();
  });

  it('T20.r accepts happy leaf foo.bar-baz.json', () => {
    expect(
      _validateLeafForTest('foo.bar-baz.json', '/tmp/foo.bar-baz.json'),
    ).toBeUndefined();
  });
});
