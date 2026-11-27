// BDD: explorer-natural-sort — 资源管理器(listDir 输出顺序)按 VSCode 默认排序:目录优先,名字里的数字段按数值比。
// 见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listDir, sortDirsFirst } from '../../../electron/main/ipc/fs/list-dir';
import { compareFileNames } from '../../../electron/shared/compare-file-names';
import type { FileEntry } from '../../../electron/shared/fs-entry';

const file = (name: string): FileEntry => ({ path: `/r/${name}`, name, isDirectory: false });
const dir = (name: string): FileEntry => ({ path: `/r/${name}`, name, isDirectory: true });
const names = (es: readonly FileEntry[]) => es.map((e) => e.name);

describe('compareFileNames(VSCode compareFileNamesDefault)', () => {
  const sorted = (xs: string[]) => [...xs].sort(compareFileNames);

  it('数字段按数值:file-2 < file-10 < file-100', () => {
    expect(sorted(['file-10', 'file-100', 'file-2', 'file-1'])).toEqual(['file-1', 'file-2', 'file-10', 'file-100']);
  });

  it('数值相等时短的在前(foo1 < foo01),结果仍是全序', () => {
    expect(sorted(['foo01', 'foo1', 'foo001'])).toEqual(['foo1', 'foo01', 'foo001']);
  });

  it('大小写混排(不把大写名整体排在小写名前)', () => {
    expect(sorted(['b.md', 'README.md', 'a.md', 'Cargo.toml'])).toEqual(['a.md', 'b.md', 'Cargo.toml', 'README.md']);
  });

  it('点文件不特殊处理:「.」按 collator 排在字母前', () => {
    expect(sorted(['src', '.gitignore', 'a.ts'])).toEqual(['.gitignore', 'a.ts', 'src']);
  });

  it('同一字符串返回 0', () => {
    expect(compareFileNames('x', 'x')).toBe(0);
  });
});

describe('sortDirsFirst', () => {
  it('已排好但按旧 localeCompare 判定的数字顺序会被重排', () => {
    // 旧实现认为 file-10 < file-2 已是有序 → 原样返回
    const out = sortDirsFirst([file('file-10'), file('file-2')]);
    expect(names(out)).toEqual(['file-2', 'file-10']);
  });

  it('目录优先,各自按数值排序', () => {
    const out = sortDirsFirst([file('img10.png'), dir('v10'), file('img9.png'), dir('v9')]);
    expect(names(out)).toEqual(['v9', 'v10', 'img9.png', 'img10.png']);
  });
});

describe('listDir(资源管理器的目录内容)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'nat-sort-'));
    for (const n of ['file-1.txt', 'file-10.txt', 'file-2.txt', 'file-20.txt']) writeFileSync(path.join(root, n), '');
    mkdirSync(path.join(root, 'ch10'));
    mkdirSync(path.join(root, 'ch2'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('file-10 排在 file-2 之后;目录在前', async () => {
    expect(names(await listDir(root))).toEqual(['ch2', 'ch10', 'file-1.txt', 'file-2.txt', 'file-10.txt', 'file-20.txt']);
  });
});
