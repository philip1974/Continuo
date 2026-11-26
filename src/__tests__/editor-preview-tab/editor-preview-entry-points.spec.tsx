// @vitest-environment jsdom
// BDD:哪些入口以预览方式打开 —— 资源管理器单击(双击 / Enter 常驻)、搜索结果匹配行单击(双击 / Enter 常驻)。见同目录 README。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const h = vi.hoisted(() => ({
  openFileByPath: vi.fn(async () => ({ ok: true as const })),
  openFileInEditor: vi.fn(async () => ({ ok: true as const, lineApplied: true })),
}));

const entries: FileEntry[] = [{ path: '/work/beta.ts', name: 'beta.ts', isDirectory: false }];

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: p === '/work' ? entries : [] })),
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
    getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
}));
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: h.openFileByPath }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/plugins/co-app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/plugins/co-app')>()),
  openFileInEditor: h.openFileInEditor,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { FolderTree } from '../../panels/Explorer/FolderTree';
import { openSearchMatch } from '../../panels/Search/search-store';
import type { SearchFileResult } from '../../../electron/shared/workspace-search';

const row = (container: HTMLElement, p: string) => container.querySelector(`[title="${p}"]`) as HTMLElement | null;

beforeEach(() => {
  h.openFileByPath.mockClear();
  h.openFileInEditor.mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
});
afterEach(() => cleanup());

describe('资源管理器', () => {
  async function mount() {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/beta.ts')).not.toBeNull());
    return r.container;
  }

  it('单击 → 以预览方式打开', async () => {
    const c = await mount();
    act(() => {
      fireEvent.click(row(c, '/work/beta.ts')!, { detail: 1 });
    });
    await waitFor(() => expect(h.openFileByPath).toHaveBeenCalledWith('/work/beta.ts', { preview: true }));
  });

  it('双击(第二下 click detail=2)→ 常驻打开', async () => {
    const c = await mount();
    act(() => {
      fireEvent.click(row(c, '/work/beta.ts')!, { detail: 1 });
      fireEvent.click(row(c, '/work/beta.ts')!, { detail: 2 });
    });
    await waitFor(() => expect(h.openFileByPath).toHaveBeenLastCalledWith('/work/beta.ts', { preview: false }));
  });

  it('Enter → 常驻打开', async () => {
    const c = await mount();
    const r = row(c, '/work/beta.ts')!;
    act(() => {
      r.focus();
      fireEvent.keyDown(r, { key: 'Enter' });
    });
    await waitFor(() => expect(h.openFileByPath).toHaveBeenCalledWith('/work/beta.ts', { preview: false }));
  });
});

describe('搜索结果', () => {
  const file: SearchFileResult = {
    path: '/work/beta.ts',
    relPath: 'beta.ts',
    matches: [{ line: 3, column: 2, length: 4, preview: 'abc', previewStart: 0, previewLength: 1 }],
  } as unknown as SearchFileResult;

  it('单击匹配行 → 以预览方式;其它(双击 / Enter / F4)→ 常驻', async () => {
    await openSearchMatch(file, 0, true);
    expect(h.openFileInEditor).toHaveBeenLastCalledWith('/work/beta.ts', { line: 3, column: 2, length: 4 }, { preview: true });
    await openSearchMatch(file, 0);
    expect(h.openFileInEditor).toHaveBeenLastCalledWith('/work/beta.ts', { line: 3, column: 2, length: 4 }, { preview: false });
  });
});
