// BDD: workspace-scan-unreadable / 扫描(main):读不了的子目录跳过并计数,根读不了才失败;资源管理器无执行权限目录报错
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listDir, scanDir } from '../../../electron/main/ipc/fs/list-dir';
import { runTextSearch } from '../../../electron/main/search/text-search';
import { LIST_DIR_MAX_DEPTH } from '../../../electron/shared/fs-limits';
import type { SearchFileResult, SearchQuery } from '../../../electron/shared/workspace-search';

const canTestPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;
// macOS / Linux:超过 PATH_MAX 的绝对路径 opendir 报 ENAMETOOLONG(Windows 另有长路径语义,不测)。
const canTestLongPath = process.platform === 'darwin' || process.platform === 'linux';

let root: string;
const restoreModes: string[] = [];
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'scan-unreadable-'));
});
afterEach(() => {
  for (const p of restoreModes.splice(0)) chmodSync(p, 0o755);
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content = 'needle\n'): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function lock(rel: string, mode: number): void {
  const full = path.join(root, rel);
  chmodSync(full, mode);
  restoreModes.push(full);
}

const query = (pattern: string): SearchQuery => ({
  pattern,
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: '',
  exclude: '',
});

async function search(): Promise<{ files: SearchFileResult[]; summary: Awaited<ReturnType<typeof runTextSearch>> }> {
  const files: SearchFileResult[] = [];
  const summary = await runTextSearch({ root, query: query('needle'), onFiles: (b) => files.push(...b) });
  return { files, summary };
}

/**
 * 建一个绝对路径超过 1024 字节的深层目录(含一个文件):先在短名父目录下建(每段 200 字符,总长在上限内),
 * 再把短名父目录改成长名 —— 改名只涉及父目录自身路径,子孙的完整路径随之超限。返回撤销函数(改回短名,便于删除)。
 */
function makeOverlongTree(): () => void {
  const seg = (c: string): string => c.repeat(200);
  const shortTop = path.join(root, 's');
  let deep = shortTop;
  for (const c of ['a', 'b', 'c', 'd']) deep = path.join(deep, seg(c));
  mkdirSync(deep, { recursive: true });
  writeFileSync(path.join(deep, 'deep.txt'), 'needle\n');
  const longTop = path.join(root, 'L'.repeat(240));
  renameSync(shortTop, longTop);
  expect(path.join(longTop, seg('a'), seg('b'), seg('c'), seg('d')).length).toBeGreaterThan(1024);
  return () => renameSync(longTop, shortTop);
}

describe('递归扫描:读不了的子目录跳过并计数', () => {
  it.skipIf(!canTestPermissions)('子目录 chmod 000 → 其余文件照常列出,skippedDirs = 1', async () => {
    write('a.ts');
    write('src/b.ts');
    write('locked/secret.ts');
    write('locked/inner/deep.ts');
    lock('locked', 0o000);
    const r = await scanDir(root, { maxDepth: LIST_DIR_MAX_DEPTH, withStats: false });
    const rels = r.entries.filter((e) => !e.isDirectory).map((e) => path.relative(root, e.path)).sort();
    expect(rels).toEqual(['a.ts', path.join('src', 'b.ts')]);
    expect(r.skippedDirs).toBe(1);
  });

  it.skipIf(!canTestLongPath)('路径超过系统上限的深层目录 → 跳过计数,不再整体失败', async () => {
    write('top.ts');
    const undo = makeOverlongTree();
    try {
      const r = await scanDir(root, { maxDepth: LIST_DIR_MAX_DEPTH, withStats: false });
      expect(r.entries.some((e) => e.name === 'top.ts')).toBe(true);
      expect(r.skippedDirs).toBeGreaterThanOrEqual(1);
    } finally {
      undo();
    }
  });

  it.skipIf(!canTestPermissions)('根目录本身读不了 → 照旧抛 FS_DENIED', async () => {
    write('locked/a.ts');
    lock('locked', 0o000);
    await expect(scanDir(path.join(root, 'locked'), { maxDepth: 4 })).rejects.toMatchObject({ code: 'FS_DENIED' });
  });

  it.skipIf(!canTestPermissions)('总条目超硬上限仍整体抛 FS_DIR_TOO_LARGE(跳过不吞掉 backstop)', async () => {
    for (let i = 0; i < 5; i += 1) write(`sub/f${i}.ts`);
    write('locked/x.ts');
    lock('locked', 0o000);
    await expect(scanDir(root, { maxDepth: 4, maxTotalEntries: 3 })).rejects.toMatchObject({
      code: 'FS_DIR_TOO_LARGE',
    });
  });
});

describe('资源管理器:无执行权限的目录(如 644)', () => {
  it.skipIf(!canTestPermissions)('展开(单层 listDir)→ FS_DENIED,不再显示为空', async () => {
    write('noexec/a.txt');
    write('noexec/b.txt');
    lock('noexec', 0o644);
    await expect(listDir(path.join(root, 'noexec'))).rejects.toMatchObject({ code: 'FS_DENIED' });
  });
});

describe('在文件中查找', () => {
  it.skipIf(!canTestPermissions)('有 chmod 000 子目录 → 结果照常,summary.skippedUnreadableDirs = 1', async () => {
    write('a.ts');
    write('src/b.ts');
    write('locked/c.ts');
    lock('locked', 0o000);
    const { files, summary } = await search();
    expect(files.map((f) => f.relPath).sort()).toEqual(['a.ts', 'src/b.ts']);
    expect(summary.skippedUnreadableDirs).toBe(1);
  });

  it.skipIf(!canTestLongPath)('有超长路径目录 → 结果照常,计入跳过', async () => {
    write('a.ts');
    const undo = makeOverlongTree();
    try {
      const { files, summary } = await search();
      expect(files.map((f) => f.relPath)).toEqual(['a.ts']);
      expect(summary.skippedUnreadableDirs).toBeGreaterThanOrEqual(1);
    } finally {
      undo();
    }
  });

  it.skipIf(!canTestPermissions)('单个文件读不了(chmod 000)/ 无执行权限目录里的文件 → 只跳过该文件,不计入目录提示', async () => {
    write('a.ts');
    write('secret.ts');
    lock('secret.ts', 0o000);
    write('noexec/x.ts');
    lock('noexec', 0o644);
    const { files, summary } = await search();
    expect(files.map((f) => f.relPath)).toEqual(['a.ts']);
    expect(summary.skippedUnreadableDirs).toBe(0);
  });
});
