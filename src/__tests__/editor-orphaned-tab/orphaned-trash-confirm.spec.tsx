// @vitest-environment jsdom
// BDD: Explorer 删除涉及有未保存修改的 tab → 确认框追加「有未保存的更改」警告(关掉删除确认设置时也照样确认,同 VSCode);
// 删除后该 tab 保留并标记已删除。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';
import { useEditorStore } from '../../stores/editor.store';
import { t } from '../../i18n';

const h = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

const entries: FileEntry[] = [
  { path: '/work/alpha', name: 'alpha', isDirectory: true },
  { path: '/work/beta.md', name: 'beta.md', isDirectory: false },
  { path: '/work/clean.md', name: 'clean.md', isDirectory: false },
];

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: p === '/work' ? entries : [] })),
      trash: vi.fn(async () => ({ ok: true, data: undefined })),
      reveal: vi.fn(),
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
  useEditorFile: () => ({ openFileByPath: vi.fn(async () => ({ ok: true })) }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (key: string, fallback: unknown) => (key in h.settings ? h.settings[key] : fallback),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { coApi } from '@/lib/co-api';
import { FolderTree } from '../../panels/Explorer/FolderTree';

const row = (container: HTMLElement, p: string) => container.querySelector(`[title="${p}"]`) as HTMLElement | null;

async function deleteRow(p: string) {
  const r = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row(r.container, p)).not.toBeNull());
  act(() => {
    fireEvent.click(row(r.container, p)!);
  });
  await waitFor(() => expect(row(r.container, p)!.getAttribute('tabindex')).toBe('0'));
  act(() => {
    fireEvent.keyDown(row(r.container, p)!, { key: 'Delete', code: 'Delete' });
  });
  return r;
}

const WARNING = () => t('panels.explorer.trash_confirm.unsaved', { count: 1 });

beforeEach(() => {
  Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
  vi.mocked(coApi.fs.trash).mockClear();
  h.settings = {};
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useEditorStore.setState({
    tabs: [
      { id: '/work/beta.md', filePath: '/work/beta.md', content: 'mine', originalContent: 'orig', dirty: true },
      { id: '/work/clean.md', filePath: '/work/clean.md', content: 'c', originalContent: 'c', dirty: false },
    ],
    activeTabId: '/work/beta.md',
  });
});
afterEach(() => cleanup());

describe('Explorer 删除有未保存修改的文件', () => {
  it('确认框追加未保存警告;确认后 tab 保留并标记已删除', async () => {
    await deleteRow('/work/beta.md');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(WARNING());
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: t('panels.explorer.ctx.trash') }));
    });
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledWith('/work/beta.md'));
    await waitFor(() => expect(useEditorStore.getState().tabs[0]).toMatchObject({ id: '/work/beta.md', orphaned: true }));
  });

  it('没有未保存 tab → 无警告', async () => {
    await deleteRow('/work/clean.md');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).not.toContain(WARNING());
  });

  it('关掉「删除前确认」设置时,涉及未保存 tab 仍弹确认(VSCode 未保存警告不受该设置控制)', async () => {
    h.settings = { 'explorer.confirmDelete': false };
    await deleteRow('/work/beta.md');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(WARNING());
    expect(coApi.fs.trash).not.toHaveBeenCalled();
  });

  it('关掉「删除前确认」且无未保存 tab → 直接删除', async () => {
    h.settings = { 'explorer.confirmDelete': false };
    await deleteRow('/work/clean.md');
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledWith('/work/clean.md'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
