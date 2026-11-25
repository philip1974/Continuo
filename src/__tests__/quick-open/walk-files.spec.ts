// BDD: quick-open / walk-files
// walkWorkspaceFiles 纯函数:调 listDir + 过滤 isDirectory + slice maxFiles。

import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { walkWorkspaceFiles } from '../../plugins/quick-open/walk-files';
import { QUICK_OPEN_MAX_FILES } from '../../plugins/quick-open/store';
import { fuzzyFilter } from '../../plugins/command-palette/fuzzy';
import { listDir as mainListDir } from '../../../electron/main/ipc/fs/list-dir';
import { LIST_DIR_MAX_DEPTH } from '../../../electron/shared/fs-limits';
import type { FileEntry } from '../../../electron/shared/fs-entry';
import type { IpcResult } from '../../../electron/shared/ipc-result';

type ListDirFn = (
  path: string,
  options?: {
    maxDepth?: number;
    exclude?: readonly string[];
    maxFiles?: number;
    withStats?: boolean;
  },
) => Promise<IpcResult<readonly FileEntry[]>>;

function entry(p: string, name: string, isDirectory: boolean): FileEntry {
  return { path: p, name, isDirectory, mtime: 0, ctime: 0 };
}

function makeListDir(data: readonly FileEntry[]): ListDirFn {
  return async () => ({ ok: true, data });
}

describe('walkWorkspaceFiles', () => {
  it('过滤 isDirectory,只返文件', async () => {
    const listDir = makeListDir([
      entry('/root/src', 'src', true),
      entry('/root/src/a.ts', 'a.ts', false),
      entry('/root/README.md', 'README.md', false),
      entry('/root/dist', 'dist', true),
    ]);
    const r = await walkWorkspaceFiles({
      rootPath: '/root',
      listDir,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.map((f) => f.name)).toEqual(['a.ts', 'README.md']);
    }
  });

  it('relPath 是 absPath 截掉 rootPath + 前导 /', async () => {
    const listDir = makeListDir([
      entry('/root/src/foo.ts', 'foo.ts', false),
    ]);
    const r = await walkWorkspaceFiles({
      rootPath: '/root',
      listDir,
    });
    if (r.ok) {
      expect(r.data[0]?.relPath).toBe('src/foo.ts');
    }
  });

  it('rootPath 末尾带 / 也能正确截 relPath', async () => {
    const listDir = makeListDir([
      entry('/root/a.ts', 'a.ts', false),
    ]);
    const r = await walkWorkspaceFiles({
      rootPath: '/root/',
      listDir,
    });
    if (r.ok) {
      expect(r.data[0]?.relPath).toBe('a.ts');
    }
  });

  it('Windows 反斜杠 rootPath → relPath 分隔符无关剥离(不退化为绝对路径)', async () => {
    const listDir = makeListDir([
      entry('C:\\repo\\src\\a.ts', 'a.ts', false),
    ]);
    const r = await walkWorkspaceFiles({ rootPath: 'C:\\repo', listDir });
    if (r.ok) {
      expect(r.data[0]?.relPath).toBe('src\\a.ts');
    }
  });

  // 跨平台(复查 P2):relPath 剥离复用 path-cross.stripRootPrefix(边界+平台感知大小写)。
  it('Windows 大小写不同 rootPath/FileEntry → 仍剥成相对(不退化绝对)', async () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });
    try {
      const listDir = makeListDir([entry('C:\\Repo\\src\\a.ts', 'a.ts', false)]);
      const r = await walkWorkspaceFiles({ rootPath: 'c:\\repo', listDir });
      if (r.ok) expect(r.data[0]?.relPath).toBe('src\\a.ts');
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
      else delete (navigator as { platform?: string }).platform;
    }
  });

  it('同前缀非子目录(边界)→ relPath 不被错剥(原样绝对)', async () => {
    const listDir = makeListDir([entry('/rooted/a.ts', 'a.ts', false)]);
    const r = await walkWorkspaceFiles({ rootPath: '/root', listDir });
    if (r.ok) expect(r.data[0]?.relPath).toBe('/rooted/a.ts'); // 不退化成 'ed/a.ts'
  });

  it('perf P2 · 把 maxFiles 下推到 listDir(main 早停,不在 renderer 才截断)', async () => {
    let captured: { maxFiles?: number } | undefined;
    const listDir: ListDirFn = async (_p, options) => {
      captured = options;
      return { ok: true, data: [] };
    };
    // 默认上限
    await walkWorkspaceFiles({ rootPath: '/r', listDir });
    expect(captured?.maxFiles).toBe(QUICK_OPEN_MAX_FILES);
    // 显式上限透传
    await walkWorkspaceFiles({ rootPath: '/r', listDir, maxFiles: 12 });
    expect(captured?.maxFiles).toBe(12);
  });

  it('perf · 调 listDir 传 withStats:false(只用 path/name/isDirectory,main 免逐项 lstat)', async () => {
    let captured: { withStats?: boolean } | undefined;
    const listDir: ListDirFn = async (_p, options) => {
      captured = options;
      return { ok: true, data: [] };
    };
    await walkWorkspaceFiles({ rootPath: '/r', listDir });
    expect(captured?.withStats).toBe(false);
  });

  it('调 listDir 时传默认 + extraExclude(dist/out/build/.next/.nuxt/.cache/.vite)', async () => {
    let captured:
      | { maxDepth?: number; exclude?: readonly string[] }
      | undefined;
    const listDir: ListDirFn = async (_path, options) => {
      captured = options;
      return { ok: true, data: [] };
    };
    await walkWorkspaceFiles({ rootPath: '/r', listDir });
    expect(captured?.maxDepth).toBe(LIST_DIR_MAX_DEPTH);
    expect(captured?.exclude).toContain('dist');
    expect(captured?.exclude).toContain('out');
    expect(captured?.exclude).toContain('build');
    expect(captured?.exclude).toContain('.next');
    expect(captured?.exclude).toContain('.nuxt');
    expect(captured?.exclude).toContain('.cache');
    expect(captured?.exclude).toContain('.vite');
    // 也含 listDir 默认的(walkWorkspaceFiles 传了完整列表,不依赖默认 fallback)
    expect(captured?.exclude).toContain('node_modules');
    expect(captured?.exclude).toContain('.git');
  });

  it('extraExclude 追加用户自定义,不覆盖内置', async () => {
    let captured: { exclude?: readonly string[] } | undefined;
    const listDir: ListDirFn = async (_p, opts) => {
      captured = opts;
      return { ok: true, data: [] };
    };
    await walkWorkspaceFiles({
      rootPath: '/r',
      listDir,
      extraExclude: ['target', 'venv'],
    });
    expect(captured?.exclude).toContain('target');
    expect(captured?.exclude).toContain('venv');
    // 内置仍在
    expect(captured?.exclude).toContain('node_modules');
    expect(captured?.exclude).toContain('dist');
  });

  it('extraExclude 为空时复用默认 exclude 引用,非空合并不走数组 spread', async () => {
    let defaultExclude: readonly string[] | undefined;
    let emptyExtraExclude: readonly string[] | undefined;
    const listDir: ListDirFn = async (_p, opts) => {
      if (!defaultExclude) defaultExclude = opts?.exclude;
      else emptyExtraExclude = opts?.exclude;
      return { ok: true, data: [] };
    };

    await walkWorkspaceFiles({ rootPath: '/r', listDir });
    await walkWorkspaceFiles({ rootPath: '/r', listDir, extraExclude: [] });

    expect(emptyExtraExclude).toBe(defaultExclude);
    expect(walkWorkspaceFiles.toString()).not.toContain('[...FULL_EXCLUDE');
  });

  it('maxFiles 默认 QUICK_OPEN_MAX_FILES(50000),文件超过截断', async () => {
    expect(QUICK_OPEN_MAX_FILES).toBe(50_000);
    const many: FileEntry[] = [];
    for (let i = 0; i < QUICK_OPEN_MAX_FILES + 1000; i++) {
      many.push(entry(`/r/f${i}.ts`, `f${i}.ts`, false));
    }
    const r = await walkWorkspaceFiles({
      rootPath: '/r',
      listDir: makeListDir(many),
    });
    if (r.ok) {
      expect(r.data.length).toBe(QUICK_OPEN_MAX_FILES);
      expect(r.data[0]?.name).toBe('f0.ts');
      expect(r.data[QUICK_OPEN_MAX_FILES - 1]?.name).toBe(`f${QUICK_OPEN_MAX_FILES - 1}.ts`);
    }
  });

  it('maxFiles 自定义', async () => {
    const many: FileEntry[] = [];
    for (let i = 0; i < 200; i++) many.push(entry(`/r/f${i}`, `f${i}`, false));
    const r = await walkWorkspaceFiles({
      rootPath: '/r',
      listDir: makeListDir(many),
      maxFiles: 100,
    });
    if (r.ok) expect(r.data.length).toBe(100);
  });

  it('maxFiles <= 0 → 直接返回空结果且不调用 listDir', async () => {
    let calls = 0;
    const listDir: ListDirFn = async () => {
      calls += 1;
      return { ok: true, data: [entry('/r/a.ts', 'a.ts', false)] };
    };

    const r = await walkWorkspaceFiles({
      rootPath: '/r',
      listDir,
      maxFiles: 0,
    });

    expect(r).toEqual({ ok: true, data: [] });
    const again = await walkWorkspaceFiles({
      rootPath: '/r',
      listDir,
      maxFiles: -1,
    });
    expect(again.ok).toBe(true);
    if (r.ok && again.ok) expect(again.data).toBe(r.data);
    expect(calls).toBe(0);
  });

  it('renderer 端过滤结果使用上限数组,不通过 files.push 扩容', async () => {
    const listDir = makeListDir([
      entry('/r/src', 'src', true),
      entry('/r/a.ts', 'a.ts', false),
      entry('/r/b.ts', 'b.ts', false),
    ]);

    const r = await walkWorkspaceFiles({ rootPath: '/r', listDir });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.map((f) => f.name)).toEqual(['a.ts', 'b.ts']);
    expect(walkWorkspaceFiles.toString()).not.toContain('files.push(');
  });

  it('listDir 返 fail → 透传', async () => {
    const listDir: ListDirFn = async () => ({
      ok: false,
      code: 'FS_NOT_DIRECTORY',
      message: 'not a dir',
    });
    const r = await walkWorkspaceFiles({ rootPath: '/x', listDir });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('FS_NOT_DIRECTORY');
    }
  });

  it('空 workspace(listDir 返空数组)→ ok 空 results', async () => {
    const r = await walkWorkspaceFiles({
      rootPath: '/r',
      listDir: makeListDir([]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([]);
  });

  it('空 workspace / 全目录结果复用稳定空 results', async () => {
    const empty = await walkWorkspaceFiles({
      rootPath: '/r',
      listDir: makeListDir([]),
    });
    const dirsOnly = await walkWorkspaceFiles({
      rootPath: '/r',
      listDir: makeListDir([
        entry('/r/src', 'src', true),
        entry('/r/dist', 'dist', true),
      ]),
    });

    expect(empty.ok).toBe(true);
    expect(dirsOnly.ok).toBe(true);
    if (empty.ok && dirsOnly.ok) {
      expect(empty.data).toEqual([]);
      expect(dirsOnly.data).toBe(empty.data);
    }
  });

  it('rootPath 空 → fail(WORKSPACE_NOT_OPEN)', async () => {
    const r = await walkWorkspaceFiles({
      rootPath: '',
      listDir: makeListDir([]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('WORKSPACE_NOT_OPEN');
  });
});

// 缺陷复现(截图审计):workspace 有 8 层目录下的长文件名 .ts,Quick Open 搜「ts」只出浅层 a.ts / b.ts。
// 原因:Quick Open 以 maxDepth=8 扫描,第 9 层的文件根本不在候选里(模糊匹配 / 结果数都不是原因)。
// VSCode 的 Quick Open 搜全工作区(无深度限制,只受 files.exclude / search.exclude 与结果上限约束)。
describe('walkWorkspaceFiles · 深层目录(真实 listDir)', () => {
  it('8 层目录下的长文件名 .ts 进入候选,搜「ts」能匹配到', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'qo-deep-'));
    try {
      const deep = path.join(root, 'packages/core/src/internal/utils/very/deep/nested');
      await mkdir(deep, { recursive: true });
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src/a.ts'), '');
      await writeFile(path.join(root, 'src/b.ts'), '');
      const longName =
        'this-is-an-extremely-long-file-name-that-should-be-truncated-somewhere-in-the-tree.ts';
      await writeFile(path.join(deep, longName), '');

      const r = await walkWorkspaceFiles({
        rootPath: root,
        listDir: async (p, opts) => ({ ok: true, data: await mainListDir(p, opts) }),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const names = fuzzyFilter(r.data, 'ts', (f) => f.relPathLower).map((f) => f.name);
      expect(names).toContain(longName);
      expect(names).toContain('a.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// 第二十四轮:2 万文件工作区(huge/ 下 2 万)⌘P 输 `file-0`,根下 file-0.ts / src/a.ts 都搜不到 —— 候选上限 5000 且
// list-dir 深度优先边读边下钻,opendir 顺序里排在前面的 huge/ 吃光名额。VSCode Quick Open 候选不截断(只截断结果数)。
describe('walkWorkspaceFiles · 大工作区(真实 listDir)', () => {
  async function makeHugeWorkspace(hugeCount: number): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'qo-huge-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'file-0.ts'), '');
    await writeFile(path.join(root, 'src/a.ts'), '');
    const perDir = 100;
    for (let d = 0; d * perDir < hugeCount; d++) {
      const dir = path.join(root, 'huge', `d${d}`);
      await mkdir(dir, { recursive: true });
      const names: string[] = [];
      for (let i = d * perDir; i < Math.min(hugeCount, (d + 1) * perDir); i++) names.push(`file-${i}.ts`);
      await Promise.all(names.map((n) => writeFile(path.join(dir, n), '')));
    }
    return root;
  }
  const realListDir = async (p: string, opts: Parameters<typeof mainListDir>[1]) =>
    ({ ok: true as const, data: await mainListDir(p, opts) });

  it('超过 5000 个文件时根下与 src/ 下的文件仍在候选里,搜 `file-0` 能找到根下 file-0.ts', async () => {
    const root = await makeHugeWorkspace(6000);
    try {
      const r = await walkWorkspaceFiles({ rootPath: root, listDir: realListDir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.length).toBe(6002);
      const rel = fuzzyFilter(r.data, 'file-0', (f) => f.relPathLower).map((f) => f.relPath);
      expect(rel).toContain('file-0.ts');
      expect(r.data.map((f) => f.relPath)).toContain('src/a.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('仍超上限而截断时,目录自身的文件先于其子目录入选(根下文件不被大子目录挤掉)', async () => {
    const root = await makeHugeWorkspace(300);
    try {
      const r = await walkWorkspaceFiles({ rootPath: root, listDir: realListDir, maxFiles: 10 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.length).toBe(10);
      expect(r.data.map((f) => f.relPath)).toContain('file-0.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
