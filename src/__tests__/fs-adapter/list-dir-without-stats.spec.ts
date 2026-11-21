// BDD: fs-adapter / listDir withStats:false
// 性能(Quick Open ⌘P):调用方不需要 size/mtime/ctime 时传 withStats:false,
// 类型直接取自 opendir 的 dirent,普通文件/目录/符号链接不再逐项 lstat。
// 仅 dirent 类型未知(isFile/isDirectory/isSymbolicLink 皆 false)回退 lstat;
// followSymlinks 解析链接目标仍走 stat。默认(withStats 不传/true)行为不变。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    stat: vi.fn(actual.stat),
    opendir: vi.fn(actual.opendir),
  };
});

const { listDir } = await import('../../../electron/main/ipc/fs/list-dir');

const lstatMock = vi.mocked(fsp.lstat);
const statMock = vi.mocked(fsp.stat);
const opendirMock = vi.mocked(fsp.opendir);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lm-fs-nostat-'));
  await mkdir(path.join(dir, 'sub'));
  await mkdir(path.join(dir, 'node_modules'));
  await writeFile(path.join(dir, 'a.txt'), 'A');
  await writeFile(path.join(dir, 'b.txt'), 'BB');
  await writeFile(path.join(dir, 'sub', 'inner.txt'), 'I');
  await symlink(path.join(dir, 'sub'), path.join(dir, 'link-dir'));
  await symlink(path.join(dir, 'a.txt'), path.join(dir, 'link-file'));
  await symlink(path.join(dir, 'missing'), path.join(dir, 'link-broken'));
  lstatMock.mockClear();
  statMock.mockClear();
  opendirMock.mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// 去掉 stat 字段,只比结构字段(name/path/isDirectory/isSymlink)
const structural = (items: readonly import('../../../electron/shared/fs-entry').FileEntry[]) =>
  items.map(({ path: p, name, isDirectory, isSymlink }) => ({
    path: p,
    name,
    isDirectory,
    ...(isSymlink && { isSymlink }),
  }));

/**
 * 普通文件/目录不 lstat。win32 例外:libuv 把所有 reparse point 报成链接(OneDrive 按需文件等在 lstat 下是普通
 * 文件),产品对 dirent 报 symlink 的项刻意回退 lstat(见 list-dir.ts resolveEntry)→ 只允许这三个链接被 lstat。
 */
function expectNoLstatExceptWin32Links(): void {
  if (process.platform !== 'win32') {
    expect(lstatMock).not.toHaveBeenCalled();
    return;
  }
  const lstatted = lstatMock.mock.calls.map((c) => String(c[0])).sort();
  expect(lstatted).toEqual(['link-broken', 'link-dir', 'link-file'].map((n) => path.join(dir, n)));
}

describe('listDir withStats:false', () => {
  it('普通文件/目录/符号链接不调用 lstat,且返回项不含 size/mtime/ctime', async () => {
    const items = await listDir(dir, { maxDepth: 2, withStats: false });
    expectNoLstatExceptWin32Links();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).not.toHaveProperty('size');
      expect(item).not.toHaveProperty('mtime');
      expect(item).not.toHaveProperty('ctime');
    }
  });

  it('默认(不传 withStats)行为不变:逐项 lstat 并带 mtime/ctime、文件带 size', async () => {
    const items = await listDir(dir);
    expect(lstatMock).toHaveBeenCalled();
    const a = items.find((i) => i.name === 'a.txt')!;
    expect(a.size).toBe(1);
    expect(typeof a.mtime).toBe('number');
    expect(typeof a.ctime).toBe('number');
    const sub = items.find((i) => i.name === 'sub')!;
    expect(sub).not.toHaveProperty('size');
    expect(typeof sub.mtime).toBe('number');
  });

  it.each([
    ['默认', {}],
    ['maxDepth=2', { maxDepth: 2 }],
    ['followSymlinks', { maxDepth: 2, followSymlinks: true }],
    ['exclude=[]', { maxDepth: 2, exclude: [] as string[] }],
    ['maxFiles=2', { maxDepth: 2, maxFiles: 2 }],
  ])('等价:%s 下 withStats:false 与 withStats:true 结构字段逐项一致', async (_label, opts) => {
    const withStats = await listDir(dir, { ...opts, withStats: true });
    const without = await listDir(dir, { ...opts, withStats: false });
    expect(structural(without)).toEqual(structural(withStats));
  });

  it('followSymlinks:true 时链接目标仍经 stat 解析(链接目录递归),但不 lstat', async () => {
    const items = await listDir(dir, {
      maxDepth: 2,
      followSymlinks: true,
      withStats: false,
    });
    expectNoLstatExceptWin32Links();
    const statted = statMock.mock.calls.map((c) => String(c[0]));
    expect(statted).toContain(path.join(dir, 'link-dir'));
    expect(items.find((i) => i.name === 'link-dir')).toMatchObject({
      isDirectory: true,
      isSymlink: true,
    });
    expect(items.some((i) => i.path === path.join(dir, 'link-dir', 'inner.txt'))).toBe(true);
  });

  it('dirent 类型未知(三者皆 false)→ 回退 lstat 判定,结果与默认一致', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    opendirMock.mockImplementationOnce(async (p, o) => {
      const real = await actual.opendir(p, o);
      return {
        async *[Symbol.asyncIterator]() {
          for await (const d of real) {
            yield {
              name: d.name,
              isFile: () => false,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            };
          }
        },
      } as unknown as Awaited<ReturnType<typeof actual.opendir>>;
    });
    const without = await listDir(dir, { withStats: false });
    expect(lstatMock).toHaveBeenCalledTimes(without.length);
    const withStats = await listDir(dir);
    expect(structural(without)).toEqual(structural(withStats));
    for (const item of without) expect(item).not.toHaveProperty('mtime');
  });

  it('maxFiles 计数口径不变:只数普通文件(符号链接/目录不计)', async () => {
    const withStats = await listDir(dir, { maxDepth: 2, maxFiles: 1 });
    const without = await listDir(dir, { maxDepth: 2, maxFiles: 1, withStats: false });
    expect(structural(without)).toEqual(structural(withStats));
    expect(without.filter((i) => !i.isDirectory && !i.isSymlink)).toHaveLength(1);
  });

  // Windows:libuv fs__readdir 对**任何** FILE_ATTRIBUTE_REPARSE_POINT 都报 DT_LINK(先于目录判断),
  // 而 lstat 只把 SYMLINK/LX_SYMLINK/junction/APPEXECLINK 视为链接 —— OneDrive 按需文件/Dedup 等
  // 其它 reparse tag 的目录/文件 lstat 是普通目录/文件。dirent 报 symlink 时须回退 lstat,口径同 withStats:true。
  describe('win32:dirent 报 symlink 而 lstat 报普通目录/文件(非链接 reparse point)', () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    afterEach(() => {
      Object.defineProperty(process, 'platform', realPlatform);
    });

    // 把真实目录 sub、真实文件 a.txt 的 dirent 伪装成 symlink(模拟 Windows libuv 对 reparse point 的报法)
    const mockReparseDirents = async (): Promise<void> => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      opendirMock.mockImplementation(async (p, o) => {
        const real = await actual.opendir(p, o);
        return {
          async *[Symbol.asyncIterator]() {
            for await (const d of real) {
              const reparse = d.name === 'sub' || d.name === 'a.txt';
              yield {
                name: d.name,
                isFile: () => (reparse ? false : d.isFile()),
                isDirectory: () => (reparse ? false : d.isDirectory()),
                isSymbolicLink: () => (reparse ? true : d.isSymbolicLink()),
              };
            }
          },
        } as unknown as Awaited<ReturnType<typeof actual.opendir>>;
      });
    };
    afterEach(() => {
      opendirMock.mockImplementation(
        async (...args: Parameters<typeof fsp.opendir>) =>
          (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).opendir(
            ...args,
          ),
      );
    });

    it('win32:回退 lstat,目录按目录递归、文件按文件计入 maxFiles,与 withStats:true 一致', async () => {
      await mockReparseDirents();
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const without = await listDir(dir, { maxDepth: 2, withStats: false });
      expect(without.find((i) => i.name === 'sub')).toEqual({
        path: path.join(dir, 'sub'),
        name: 'sub',
        isDirectory: true,
      });
      expect(without.find((i) => i.name === 'a.txt')).toEqual({
        path: path.join(dir, 'a.txt'),
        name: 'a.txt',
        isDirectory: false,
      });
      expect(without.some((i) => i.path === path.join(dir, 'sub', 'inner.txt'))).toBe(true);
      const withStats = await listDir(dir, { maxDepth: 2, withStats: true });
      expect(structural(without)).toEqual(structural(withStats));
      // a.txt 计入 maxFiles:maxFiles=1 时与 withStats:true 结果一致
      const capped = await listDir(dir, { maxDepth: 2, maxFiles: 1, withStats: false });
      const cappedWith = await listDir(dir, { maxDepth: 2, maxFiles: 1, withStats: true });
      expect(structural(capped)).toEqual(structural(cappedWith));
    });

    it('win32:真符号链接经 lstat 仍判为链接(不递归)', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const without = await listDir(dir, { maxDepth: 2, withStats: false });
      expect(without.find((i) => i.name === 'link-dir')).toMatchObject({
        isDirectory: false,
        isSymlink: true,
      });
      const lstatted = lstatMock.mock.calls.map((c) => String(c[0]));
      expect(lstatted).toContain(path.join(dir, 'link-dir'));
      expect(lstatted).not.toContain(path.join(dir, 'b.txt')); // 普通项仍走快速路径
    });

    it('非 win32:dirent 类型直接采信(快速路径不变,不 lstat)', async () => {
      await mockReparseDirents();
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const without = await listDir(dir, { maxDepth: 2, withStats: false });
      expect(lstatMock).not.toHaveBeenCalled();
      expect(without.find((i) => i.name === 'sub')).toMatchObject({ isSymlink: true });
    });
  });
});
