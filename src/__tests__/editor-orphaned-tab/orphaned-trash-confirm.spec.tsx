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
import { useAutoSave } from '../../panels/Editor/useAutoSave';

/** 编辑器的自动保存(活动 tab = 脏的 beta.md);保存 = 写盘并标记为干净。 */
function AutoSaveProbe({ saveTab }: { saveTab: (tabId: string) => Promise<unknown> }) {
  useAutoSave(saveTab, { enabled: true, delayMs: 1000 });
  return null;
}
const saveToDisk = vi.fn(async (tabId: string) => {
  useEditorStore.setState((s) => ({
    tabs: s.tabs.map((tab) => (tab.id === tabId ? { ...tab, originalContent: tab.content, dirty: false } : tab)),
  }));
  return { ok: true };
});

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
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

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

  // 确认框打开期间自动保存暂停(同 EditorPanel 关闭脏 tab 的确认框):否则停留超过自动保存延迟就把修改写盘,
  // 删除后 tab 已不脏被直接关掉,与框内「编辑器保留并标记为已删除」矛盾。
  it('确认框打开 3 秒(超过自动保存延迟)后确认 → 期间不自动保存,脏 tab 仍保留并标记已删除', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saveToDisk.mockClear();
    render(<AutoSaveProbe saveTab={saveToDisk} />);
    await deleteRow('/work/beta.md');
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(saveToDisk).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: t('panels.explorer.ctx.trash') }));
    });
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledWith('/work/beta.md'));
    await waitFor(() =>
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ id: '/work/beta.md', dirty: true, orphaned: true }),
    );
    // 删除后同样不自动写回(orphaned)。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(saveToDisk).not.toHaveBeenCalled();
  });

  it('确认后移到废纸篓在途超过自动保存延迟 → 期间也不自动保存,完成后 tab 保留并标记已删除', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saveToDisk.mockClear();
    let finishTrash: () => void = () => {};
    vi.mocked(coApi.fs.trash).mockImplementationOnce(
      () => new Promise((resolve) => (finishTrash = () => resolve({ ok: true, data: undefined }))),
    );
    render(<AutoSaveProbe saveTab={saveToDisk} />);
    await deleteRow('/work/beta.md');
    const dialog = await screen.findByRole('alertdialog');
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: t('panels.explorer.ctx.trash') }));
    });
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledWith('/work/beta.md'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(saveToDisk).not.toHaveBeenCalled();
    await act(async () => finishTrash());
    await waitFor(() =>
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ id: '/work/beta.md', dirty: true, orphaned: true }),
    );
  });

  it('取消确认框 → 自动保存恢复,仍脏照常保存', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saveToDisk.mockClear();
    render(<AutoSaveProbe saveTab={saveToDisk} />);
    await deleteRow('/work/beta.md');
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(saveToDisk).toHaveBeenCalledWith('/work/beta.md', { recreateMissing: false });
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
