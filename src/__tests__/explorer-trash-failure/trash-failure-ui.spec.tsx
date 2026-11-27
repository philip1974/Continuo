// @vitest-environment jsdom
// BDD: explorer-trash-failure / 资源管理器:移到废纸篓失败 → 本地化原因 toast;FS_TRASH_FAILED → 永久删除确认框
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const h = vi.hoisted(() => ({
  settings: { 'explorer.confirmDelete': false } as Record<string, unknown>,
  notifyError: vi.fn(),
}));

const entries: FileEntry[] = [
  { path: '/work/a.txt', name: 'a.txt', isDirectory: false },
  { path: '/work/b.txt', name: 'b.txt', isDirectory: false },
];

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: p === '/work' ? entries : [] })),
      trash: vi.fn(),
      deletePermanently: vi.fn(async () => ({ ok: true, data: undefined })),
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
vi.mock('@/notifications/notify', () => ({
  notify: { error: h.notifyError, info: vi.fn(), warn: vi.fn(), success: vi.fn() },
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
import { setLocale } from '@/i18n';
import { useEditorStore } from '../../stores/editor.store';
import { FolderTree } from '../../panels/Explorer/FolderTree';

const row = (container: HTMLElement, p: string) => container.querySelector(`[title="${p}"]`) as HTMLElement | null;

async function deleteRow(p: string): Promise<HTMLElement> {
  const { container } = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row(container, p)).not.toBeNull());
  act(() => {
    fireEvent.click(row(container, p)!);
  });
  await waitFor(() => expect(row(container, p)!.getAttribute('tabindex')).toBe('0'));
  act(() => {
    fireEvent.keyDown(row(container, p)!, { key: 'Delete', code: 'Delete' });
  });
  return container;
}

beforeEach(() => {
  setLocale('zh');
  h.notifyError.mockClear();
  vi.mocked(coApi.fs.trash).mockReset();
  vi.mocked(coApi.fs.deletePermanently).mockClear();
  Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useEditorStore.setState({ activeTabId: null });
});
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('权限类失败', () => {
  it('FS_DENIED → toast「无法将「a.txt」移到废纸篓:拒绝访问」;不含原始 errno 串与完整路径;不弹永久删除框', async () => {
    vi.mocked(coApi.fs.trash).mockResolvedValue({
      ok: false,
      code: 'FS_DENIED',
      message: "trash failed: /work/a.txt",
    });
    await deleteRow('/work/a.txt');
    await waitFor(() => expect(h.notifyError).toHaveBeenCalled());
    const text = h.notifyError.mock.calls[0]![0] as string;
    expect(text).toBe('无法将「a.txt」移到废纸篓：拒绝访问');
    expect(text).not.toContain('/work/');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(coApi.fs.deletePermanently).not.toHaveBeenCalled();
  });
});

describe('非权限类失败(卷不支持废纸篓等)', () => {
  beforeEach(() => {
    vi.mocked(coApi.fs.trash).mockResolvedValue({ ok: false, code: 'FS_TRASH_FAILED', message: 'trash failed' });
  });

  it('弹确认框:文案明确不可撤销,主按钮「永久删除」,初始焦点在「取消」;取消 → 不删', async () => {
    await deleteRow('/work/a.txt');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('无法将「a.txt」移到废纸篓。是否改为永久删除？');
    expect(dialog.textContent).toContain('此操作不可撤销');
    const confirm = within(dialog).getByRole('button', { name: '永久删除' });
    const cancel = within(dialog).getByRole('button', { name: '取消' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(confirm).toBeTruthy();
    expect(h.notifyError).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(cancel);
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(coApi.fs.deletePermanently).not.toHaveBeenCalled();
  });

  it('确认 → 调永久删除;失败给本地化 toast', async () => {
    vi.mocked(coApi.fs.deletePermanently).mockResolvedValueOnce({ ok: false, code: 'FS_DENIED', message: 'x' });
    await deleteRow('/work/a.txt');
    const dialog = await screen.findByRole('alertdialog');
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }));
    });
    await waitFor(() => expect(coApi.fs.deletePermanently).toHaveBeenCalledWith('/work/a.txt'));
    await waitFor(() => expect(h.notifyError).toHaveBeenCalled());
    expect(h.notifyError.mock.calls[0]![0]).toBe('永久删除「a.txt」失败：拒绝访问');
  });
});
