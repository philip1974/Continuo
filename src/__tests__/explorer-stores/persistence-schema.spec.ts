import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ExplorerSchema,
  loadExplorer,
  saveExplorer,
} from '../../../electron/main/persistence';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lm-explorer-'));
  file = path.join(dir, 'explorer.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const validPayload = {
  version: 1 as const,
  workspace: {
    root: '/Users/me/work',
    recentRoots: ['/Users/me/work', '/Users/me/old'],
  },
  explorer: {
    activePath: '/Users/me/work/file.md',
    expandedPaths: ['/Users/me/work', '/Users/me/work/sub'],
    sort: { by: 'name' as const, reverse: false },
  },
  pinned: {
    paths: ['/Users/me/work/important.md'],
  },
};

describe('ExplorerSchema', () => {
  it('完整对象 round-trip', async () => {
    await saveExplorer(file, validPayload);
    const back = await loadExplorer(file);
    expect(back).toEqual(validPayload);
  });

  it('缺失文件 → null(首次启动语义)', async () => {
    expect(await loadExplorer(file)).toBeNull();
  });

  it('损坏 JSON → null,不抛', async () => {
    await writeFile(file, '{not json');
    expect(await loadExplorer(file)).toBeNull();
  });

  it('schema 拒绝 version !== 1', () => {
    expect(() =>
      ExplorerSchema.parse({ ...validPayload, version: 2 }),
    ).toThrow();
  });

  it('schema 拒绝缺顶层字段', () => {
    expect(() =>
      ExplorerSchema.parse({ version: 1, workspace: validPayload.workspace }),
    ).toThrow();
  });

  it('schema 拒绝未知顶层字段(strict)', () => {
    expect(() =>
      ExplorerSchema.parse({ ...validPayload, weird: true }),
    ).toThrow();
  });

  it('schema 拒绝非合法 sort.by', () => {
    expect(() =>
      ExplorerSchema.parse({
        ...validPayload,
        explorer: {
          ...validPayload.explorer,
          sort: { by: 'random', reverse: false },
        },
      }),
    ).toThrow();
  });

  it('workspace.root 允许 null', () => {
    const ok = ExplorerSchema.parse({
      ...validPayload,
      workspace: { root: null, recentRoots: [] },
    });
    expect(ok.workspace.root).toBeNull();
  });

  it('explorer.activePath 允许 null', () => {
    const ok = ExplorerSchema.parse({
      ...validPayload,
      explorer: { ...validPayload.explorer, activePath: null },
    });
    expect(ok.explorer.activePath).toBeNull();
  });

  it('saveExplorer 拒绝非 schema 对象', async () => {
    await expect(saveExplorer(file, 'oops' as unknown)).rejects.toThrow();
    await expect(saveExplorer(file, { version: 1 } as unknown)).rejects.toThrow();
  });
});
