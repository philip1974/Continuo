// @vitest-environment jsdom
// BDD: explorer-git-decorations / 文件树接线:git 快照 → 文件着色 + 字母、文件夹继承颜色;设置开关;装饰全关不查询 git
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const h = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

const fsTree = new Map<string, FileEntry[]>([
  [
    '/work',
    [
      { path: '/work/src', name: 'src', isDirectory: true },
      { path: '/work/.gitignore', name: '.gitignore', isDirectory: false },
      { path: '/work/debug.log', name: 'debug.log', isDirectory: false },
      { path: '/work/new.ts', name: 'new.ts', isDirectory: false },
      // 磁盘原样 NFD 的韩文名(git 输出 NFC)
      { path: '/work/\u1112\u1161\u11ab.ts', name: '\u1112\u1161\u11ab.ts', isDirectory: false },
    ],
  ],
]);

vi.mock('@/lib/co-api', () => ({
  coApi: {
    git: {
      status: vi.fn(async () => ({
        ok: true,
        data: {
          root: '/work',
          entries: [
            ['src/a.ts', 'modified', 'M'],
            ['new.ts', 'untracked', 'U'],
            ['debug.log', 'ignored', ''],
            ['\uD55C.ts', 'modified', 'M'],
          ],
        },
      })),
    },
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: fsTree.get(p) ?? [] })),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
      onWatchLost: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 28,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: () => {},
  }),
}));
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: vi.fn() }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (key: string, fallback: unknown) => (key in h.settings ? h.settings[key] : fallback),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { coApi } from '@/lib/co-api';
import { FolderTree } from '../../panels/Explorer/FolderTree';

const nameOf = (container: HTMLElement, p: string) =>
  container.querySelector(`[title^="${p}"] span.truncate`) as HTMLElement | null;

beforeEach(() => {
  h.settings = {};
  vi.mocked(coApi.git.status).mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
});
afterEach(() => cleanup());

describe('文件树 git 装饰', () => {
  it('默认:点文件可见;未跟踪文件着色 + U;忽略项置灰;文件夹继承子项颜色、无字母', async () => {
    const { container } = render(<FolderTree root="/work" />);
    await waitFor(() => expect(nameOf(container, '/work/new.ts')?.className).toContain('text-git-untracked'));
    expect(nameOf(container, '/work/.gitignore')).not.toBeNull();
    expect(container.querySelector('[title^="/work/new.ts"]')!.textContent).toMatch(/U$/);
    expect(nameOf(container, '/work/debug.log')!.className).toContain('text-git-ignored');
    expect(nameOf(container, '/work/src')!.className).toContain('text-git-modified');
    expect(container.querySelector('[title="/work/src"]')!.textContent).toBe('▸src');
    // NFD 文件名照常着色 + 字母
    expect(nameOf(container, '/work/\u1112\u1161\u11ab.ts')!.className).toContain('text-git-modified');
    expect(container.querySelector('[title^="/work/\u1112\u1161\u11ab.ts"]')!.textContent).toMatch(/M$/);
  });

  it('decorations.badges 关 → 只着色无字母;decorations.colors 关 → 只有字母', async () => {
    h.settings = { 'explorer.decorations.badges': false };
    const a = render(<FolderTree root="/work" />);
    await waitFor(() => expect(nameOf(a.container, '/work/new.ts')?.className).toContain('text-git-untracked'));
    expect(a.container.querySelector('[title^="/work/new.ts"]')!.textContent).not.toMatch(/U$/);
    a.unmount();

    h.settings = { 'explorer.decorations.colors': false };
    const b = render(<FolderTree root="/work" />);
    await waitFor(() => expect(b.container.querySelector('[title^="/work/new.ts"]')?.textContent).toMatch(/U$/));
    expect(nameOf(b.container, '/work/new.ts')!.className).toBe('truncate');
  });

  it('两项都关 → 不查询 git、无装饰', async () => {
    h.settings = { 'explorer.decorations.colors': false, 'explorer.decorations.badges': false };
    const { container } = render(<FolderTree root="/work" />);
    await waitFor(() => expect(nameOf(container, '/work/new.ts')).not.toBeNull());
    expect(coApi.git.status).not.toHaveBeenCalled();
    expect(nameOf(container, '/work/new.ts')!.className).toBe('truncate');
  });
});
