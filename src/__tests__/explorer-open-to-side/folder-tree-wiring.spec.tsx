// @vitest-environment jsdom
// BDD:资源管理器里「在侧边打开」/「在文件夹中查找…」接到真实文件树 —— ⌥ 单击 / ⌥ 双击文件行、右键菜单项、树内键位。
// 见 explorer-open-to-side / explorer-find-in-folder 两个 README。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const h = vi.hoisted(() => ({
  openFileByPath: vi.fn(async () => ({ ok: true as const })),
  openFilesToSide: vi.fn(async () => {}),
  findInFolders: vi.fn(),
}));

const listing: Record<string, FileEntry[]> = {
  '/work': [
    { path: '/work/src', name: 'src', isDirectory: true },
    { path: '/work/beta.ts', name: 'beta.ts', isDirectory: false },
  ],
};

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: listing[p] ?? [] })),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
      onWatchLost: vi.fn(() => vi.fn()),
      onRootPresenceChanged: vi.fn(() => vi.fn()),
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
vi.mock('@/panels/Editor/useEditorFile', () => {
  const editorFile = { openFileByPath: h.openFileByPath };
  return { useEditorFile: () => editorFile };
});
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));
vi.mock('@/shell/dock/explorer-editor-drop', async (orig) => ({
  ...(await orig<typeof import('@/shell/dock/explorer-editor-drop')>()),
  openFilesToSide: h.openFilesToSide,
}));
vi.mock('@/panels/Search/find-in-folder', async (orig) => ({
  ...(await orig<typeof import('@/panels/Search/find-in-folder')>()),
  findInFolders: h.findInFolders,
}));

import { FolderTree } from '../../panels/Explorer/FolderTree';
import { setLocale } from '../../i18n';

const row = (container: HTMLElement, p: string) => container.querySelector(`[title="${p}"]`) as HTMLElement | null;

beforeEach(() => {
  setLocale('en');
  h.openFileByPath.mockClear();
  h.openFilesToSide.mockClear();
  h.findInFolders.mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
});
afterEach(() => cleanup());

async function mount() {
  const r = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row(r.container, '/work/beta.ts')).not.toBeNull());
  return r.container;
}

describe('⌥ 单击文件行 → 在侧边打开', () => {
  it('⌥ 单击:预览、焦点留在资源管理器;不走普通打开', async () => {
    const c = await mount();
    act(() => {
      fireEvent.click(row(c, '/work/beta.ts')!, { detail: 1, altKey: true });
    });
    await waitFor(() =>
      expect(h.openFilesToSide).toHaveBeenCalledWith(['/work/beta.ts'], { preview: true, preserveFocus: true }),
    );
    expect(h.openFileByPath).not.toHaveBeenCalled();
  });

  it('⌥ 双击:常驻、聚焦侧边组', async () => {
    const c = await mount();
    act(() => {
      fireEvent.click(row(c, '/work/beta.ts')!, { detail: 1, altKey: true });
      fireEvent.click(row(c, '/work/beta.ts')!, { detail: 2, altKey: true });
    });
    await waitFor(() =>
      expect(h.openFilesToSide).toHaveBeenLastCalledWith(['/work/beta.ts'], { preview: false, preserveFocus: false }),
    );
  });

  it('不按 ⌥ 单击 → 照常在活动组预览打开', async () => {
    const c = await mount();
    act(() => {
      fireEvent.click(row(c, '/work/beta.ts')!, { detail: 1 });
    });
    await waitFor(() => expect(h.openFileByPath).toHaveBeenCalledWith('/work/beta.ts', { preview: true }));
    expect(h.openFilesToSide).not.toHaveBeenCalled();
  });
});

describe('右键菜单接线', () => {
  it('文件「Open to the Side」→ openFilesToSide([文件])', async () => {
    const c = await mount();
    fireEvent.contextMenu(row(c, '/work/beta.ts')!);
    fireEvent.click(screen.getByRole('menuitem', { name: /Open to the Side/ }));
    expect(h.openFilesToSide).toHaveBeenCalledWith(['/work/beta.ts']);
  });

  it('文件夹「Find in Folder…」→ 以该文件夹查找', async () => {
    const c = await mount();
    fireEvent.contextMenu(row(c, '/work/src')!);
    fireEvent.click(screen.getByRole('menuitem', { name: /Find in Folder/ }));
    expect(h.findInFolders).toHaveBeenCalledWith('/work', ['/work/src']);
  });

  it('树内 ⇧⌥F(焦点在文件夹)→ 以该文件夹查找;焦点在文件 → 不处理', async () => {
    const c = await mount();
    const src = row(c, '/work/src')!;
    act(() => {
      fireEvent.click(src);
      src.focus();
    });
    act(() => {
      fireEvent.keyDown(src, { key: 'Ï', code: 'KeyF', shiftKey: true, altKey: true });
    });
    expect(h.findInFolders).toHaveBeenCalledWith('/work', ['/work/src']);
    const beta = row(c, '/work/beta.ts')!;
    act(() => {
      fireEvent.click(beta);
      beta.focus();
    });
    act(() => {
      fireEvent.keyDown(beta, { key: 'Ï', code: 'KeyF', shiftKey: true, altKey: true });
    });
    expect(h.findInFolders).toHaveBeenCalledTimes(1);
  });

  it('多选(文件夹 + 文件)右键文件「Open to the Side」→ 只打开文件;「Find in Folder…」在文件夹菜单里,文件取所在目录', async () => {
    const c = await mount();
    act(() => {
      fireEvent.click(row(c, '/work/src')!);
      fireEvent.click(row(c, '/work/beta.ts')!, { metaKey: true, ctrlKey: true });
    });
    fireEvent.contextMenu(row(c, '/work/beta.ts')!);
    fireEvent.click(screen.getByRole('menuitem', { name: /Open to the Side/ }));
    expect(h.openFilesToSide).toHaveBeenCalledWith(['/work/beta.ts']);
    fireEvent.contextMenu(row(c, '/work/src')!);
    fireEvent.click(screen.getByRole('menuitem', { name: /Find in Folder/ }));
    expect(h.findInFolders).toHaveBeenCalledWith('/work', ['/work/src', '/work']);
  });
});
