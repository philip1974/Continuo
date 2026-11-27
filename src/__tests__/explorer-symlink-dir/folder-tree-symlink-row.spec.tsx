// @vitest-environment jsdom
// BDD: explorer-symlink-dir / 行渲染:符号链接目录显示为可展开文件夹 + 链接角标(读屏可感知);
// 点击展开而非当作文件打开;指向文件 / 悬空的链接按文件显示,同样带链接角标。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';
import { t } from '../../i18n';

const h = vi.hoisted(() => ({
  openFileByPath: null as null | ((p: string) => Promise<{ ok: true }>),
  editorFile: null as null | { openFileByPath: (p: string) => Promise<{ ok: true }> },
}));

const fsTree = new Map<string, FileEntry[]>([
  [
    '/work',
    [
      { path: '/work/link-dir', name: 'link-dir', isDirectory: true, isSymlink: true },
      { path: '/work/plain.ts', name: 'plain.ts', isDirectory: false },
      { path: '/work/link-broken', name: 'link-broken', isDirectory: false, isSymlink: true },
    ],
  ],
  ['/work/link-dir', [{ path: '/work/link-dir/inner.ts', name: 'inner.ts', isDirectory: false }]],
]);

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: fsTree.get(p) ?? [] })),
      move: vi.fn(),
      copy: vi.fn(),
      trash: vi.fn(),
      reveal: vi.fn(),
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
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: () => {},
  }),
}));
vi.mock('@/panels/Editor/useEditorFile', () => ({ useEditorFile: () => h.editorFile }));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { FolderTree } from '../../panels/Explorer/FolderTree';
import { useExplorerClipboardStore } from '../../panels/Explorer/clipboard-store';

const LINK_LABEL = /^(Symbolic link|符号链接|심볼릭 링크)$/;

const row = (container: HTMLElement, p: string) =>
  container.querySelector(`[role="treeitem"][title^="${p}"]`) as HTMLElement | null;

beforeEach(() => {
  h.openFileByPath = vi.fn(async () => ({ ok: true as const }));
  h.editorFile = { openFileByPath: h.openFileByPath };
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useExplorerClipboardStore.setState({ kind: null, paths: [] });
});
afterEach(() => {
  cleanup();
});

describe('FolderTree · 符号链接行', () => {
  it('链接目录是可展开文件夹(aria-expanded),带链接角标;普通文件无角标', async () => {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/link-dir')).not.toBeNull());
    const link = row(r.container, '/work/link-dir')!;
    expect(link.getAttribute('aria-expanded')).toBe('false');
    expect([...link.querySelectorAll('span')].some((s) => LINK_LABEL.test(s.textContent ?? ''))).toBe(true);
    const plain = row(r.container, '/work/plain.ts')!;
    expect([...plain.querySelectorAll('span')].some((s) => LINK_LABEL.test(s.textContent ?? ''))).toBe(false);
    // 悬空链接:文件行(无 aria-expanded)仍带角标
    const broken = row(r.container, '/work/link-broken')!;
    expect(broken.hasAttribute('aria-expanded')).toBe(false);
    expect([...broken.querySelectorAll('span')].some((s) => LINK_LABEL.test(s.textContent ?? ''))).toBe(true);
    // 悬浮提示也说明是符号链接
    expect(link.getAttribute('title')).toMatch(/Symbolic link|符号链接|심볼릭 링크/);
  });

  it('点击链接目录 → 展开列出子项,不当作文件打开', async () => {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/link-dir')).not.toBeNull());
    const link = row(r.container, '/work/link-dir')!;
    fireEvent.mouseDown(link);
    fireEvent.click(link);
    await waitFor(() => expect(row(r.container, '/work/link-dir/inner.ts')).not.toBeNull());
    expect(h.openFileByPath).not.toHaveBeenCalled();
  });

  // 对齐 VSCode getMoveToTrashMessage:只有「是目录且不是符号链接」才说「及其内容」—— 删链接只删链接本身,目标内容不动。
  it('删除指向目录的链接 → 确认框按文件措辞,不说「及其内容」', async () => {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/link-dir')).not.toBeNull());
    const link = row(r.container, '/work/link-dir')!;
    act(() => {
      fireEvent.click(link);
    });
    await waitFor(() => expect(row(r.container, '/work/link-dir')!.getAttribute('tabindex')).toBe('0'));
    act(() => {
      fireEvent.keyDown(row(r.container, '/work/link-dir')!, { key: 'Delete', code: 'Delete' });
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(t('panels.explorer.trash_confirm.file', { name: 'link-dir' }));
    expect(dialog.textContent).not.toContain(t('panels.explorer.trash_confirm.folder', { name: 'link-dir' }));
  });
});
