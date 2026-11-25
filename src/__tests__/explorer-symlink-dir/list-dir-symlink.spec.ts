// BDD: explorer-symlink-dir / 主进程 listDir 对符号链接的类型判定
// 对齐 VSCode:指向目录的符号链接在资源管理器里是可展开的文件夹(带链接标记);悬空 / 自环链接按文件显示;
// 递归扫描(Quick Open 等,maxDepth > 1)仍不跟随链接(防循环)。见 README.md。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listDir } from '../../../electron/main/ipc/fs/list-dir';

const isWin = process.platform === 'win32';
let dir: string;

beforeEach(async () => {
  // realpath:macOS tmpdir 本身经 /var → /private/var 链接;用规范路径便于比对子项路径
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'co-symlink-dir-')));
  await mkdir(path.join(dir, 'target'));
  await writeFile(path.join(dir, 'target', 'deep.txt'), 'D');
  await writeFile(path.join(dir, 'a.txt'), 'A');
  await symlink(path.join(dir, 'target'), path.join(dir, 'link-dir'), 'dir');
  await symlink(path.join(dir, 'a.txt'), path.join(dir, 'link-file'));
  await symlink(path.join(dir, 'missing'), path.join(dir, 'link-broken'));
  // target/up-loop → ..(= dir):指向祖先的循环链接
  await symlink('..', path.join(dir, 'target', 'up-loop'), 'dir');
  await symlink('self-loop', path.join(dir, 'self-loop'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const byName = (items: readonly { name: string }[], name: string) => items.find((i) => i.name === name);

describe.skipIf(isWin)('listDir 浅层(maxDepth=1):符号链接按目标类型', () => {
  it.each([true, false])('指向目录的链接 → isDirectory:true + isSymlink:true(withStats:%s)', async (withStats) => {
    const items = await listDir(dir, { withStats });
    expect(byName(items, 'link-dir')).toMatchObject({
      path: path.join(dir, 'link-dir'),
      isDirectory: true,
      isSymlink: true,
    });
    const inTarget = await listDir(path.join(dir, 'target'), { withStats });
    expect(byName(inTarget, 'up-loop')).toMatchObject({ isDirectory: true, isSymlink: true });
  });

  it('指向文件 / 悬空 / 自环的链接 → 按文件显示,仍带 isSymlink', async () => {
    const items = await listDir(dir);
    for (const name of ['link-file', 'link-broken', 'self-loop']) {
      expect(byName(items, name)).toMatchObject({ isDirectory: false, isSymlink: true });
    }
  });

  it('链接目录排在目录组(目录优先排序)', async () => {
    const names = (await listDir(dir)).map((i) => i.name);
    expect(names.indexOf('link-dir')).toBeLessThan(names.indexOf('a.txt'));
  });

  it('展开链接目录:子项路径以链接路径显示(不 realpath 改写)', async () => {
    const items = await listDir(path.join(dir, 'link-dir'));
    expect(items.map((i) => i.path).sort()).toEqual(
      [path.join(dir, 'link-dir', 'deep.txt'), path.join(dir, 'link-dir', 'up-loop')].sort(),
    );
  });

  it('循环链接逐层展开不卡死:逐层 listDir 链接路径(不 realpath),每层都再列出该链接', async () => {
    let p = path.join(dir, 'target');
    for (let level = 0; level < 5; level++) {
      p = path.join(p, 'up-loop', 'target'); // 每层:target/up-loop → dir,再进 target
      const items = await listDir(p);
      expect(byName(items, 'up-loop')).toMatchObject({
        path: path.join(p, 'up-loop'),
        isDirectory: true,
        isSymlink: true,
      });
    }
  });
});

describe.skipIf(isWin)('listDir 递归(maxDepth>1,Quick Open 等)仍不跟随链接', () => {
  it('不递归进链接目录 / 循环链接,链接项类型保持 lstat 口径', async () => {
    const items = await listDir(dir, { maxDepth: 4, withStats: false });
    expect(items.filter((i) => i.name === 'deep.txt').map((i) => i.path)).toEqual([
      path.join(dir, 'target', 'deep.txt'),
    ]);
    const upLoop = path.join(dir, 'target', 'up-loop');
    expect(items.some((i) => i.path.startsWith(upLoop + path.sep))).toBe(false);
    expect(byName(items, 'up-loop')).toMatchObject({ isDirectory: false, isSymlink: true });
    expect(byName(items, 'link-dir')).toMatchObject({ isDirectory: false, isSymlink: true });
  });
});
