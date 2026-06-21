// BDD: quick-open / walk-files
// walkWorkspaceFiles 纯函数:调 listDir + 过滤 isDirectory + slice maxFiles。

import { describe, it, expect } from 'vitest';
import { walkWorkspaceFiles } from '../../plugins/quick-open/walk-files';
import type { FileEntry } from '../../../electron/shared/fs-entry';
import type { IpcResult } from '../../../electron/shared/ipc-result';

type ListDirFn = (
  path: string,
  options?: {
    maxDepth?: number;
    exclude?: readonly string[];
    maxFiles?: number;
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

  it('perf P2 · 把 maxFiles 下推到 listDir(main 早停,不在 renderer 才截断)', async () => {
    let captured: { maxFiles?: number } | undefined;
    const listDir: ListDirFn = async (_p, options) => {
      captured = options;
      return { ok: true, data: [] };
    };
    // 默认上限
    await walkWorkspaceFiles({ rootPath: '/r', listDir });
    expect(captured?.maxFiles).toBe(5000);
    // 显式上限透传
    await walkWorkspaceFiles({ rootPath: '/r', listDir, maxFiles: 12 });
    expect(captured?.maxFiles).toBe(12);
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
    expect(captured?.maxDepth).toBe(8);
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

  it('maxFiles 默认 5000,文件超过截断', async () => {
    const many: FileEntry[] = [];
    for (let i = 0; i < 6000; i++) {
      many.push(entry(`/r/f${i}.ts`, `f${i}.ts`, false));
    }
    const r = await walkWorkspaceFiles({
      rootPath: '/r',
      listDir: makeListDir(many),
    });
    if (r.ok) {
      expect(r.data.length).toBe(5000);
      expect(r.data[0]?.name).toBe('f0.ts');
      expect(r.data[4999]?.name).toBe('f4999.ts');
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

  it('rootPath 空 → fail(WORKSPACE_NOT_OPEN)', async () => {
    const r = await walkWorkspaceFiles({
      rootPath: '',
      listDir: makeListDir([]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('WORKSPACE_NOT_OPEN');
  });
});
