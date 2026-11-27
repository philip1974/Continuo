// @vitest-environment jsdom
// BDD: explorer-batch-transfer / 文件操作的进度与并发:粘贴 / 删除进行中顶部细进度条(VSCode ProgressLocation.Explorer,
// delay 500);上一批还在写时再粘贴 → 挑到不同名字(`a copy 2.txt`),不报「已存在」;粘贴到别的目录不被它挡住;
// 失败文案只写名字。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

interface Deferred {
  resolve: (r: { ok: true; data: undefined } | { ok: false; code: string; message: string }) => void;
}

const h = vi.hoisted(() => ({
  settings: { 'explorer.confirmDelete': false } as Record<string, unknown>,
  notifyError: vi.fn(),
  names: new Set<string>(),
  pending: [] as Deferred[],
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({
        ok: true,
        data:
          p === '/work'
            ? [
                ...[...h.names].map((name): FileEntry => ({ path: `/work/${name}`, name, isDirectory: false })),
                { path: '/work/sub', name: 'sub', isDirectory: true },
              ]
            : [],
      })),
      copy: vi.fn(
        (_src: string, dest: string) =>
          new Promise((resolve) => {
            h.pending.push({
              resolve: (r) => {
                if (r.ok && dest.lastIndexOf('/') === '/work'.length) h.names.add(dest.slice('/work/'.length));
                resolve(r);
              },
            });
          }),
      ),
      move: vi.fn(),
      trash: vi.fn(
        () =>
          new Promise((resolve) => {
            h.pending.push({ resolve });
          }),
      ),
      deletePermanently: vi.fn(),
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
import { useExplorerClipboardStore } from '../../panels/Explorer/clipboard-store';
import { EXPLORER_PROGRESS_DELAY_MS, FolderTree } from '../../panels/Explorer/FolderTree';

const row = (container: HTMLElement, p: string) => container.querySelector(`[title="${p}"]`) as HTMLElement | null;
const progress = () => document.querySelector('[role="progressbar"]');
const flushAsync = () => act(async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
});

async function focusRow(p: string): Promise<{ container: HTMLElement; el: HTMLElement }> {
  const { container } = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row(container, p)).not.toBeNull());
  act(() => {
    fireEvent.click(row(container, p)!);
  });
  await waitFor(() => expect(row(container, p)!.getAttribute('tabindex')).toBe('0'));
  return { container, el: row(container, p)! };
}

function paste(el: HTMLElement): void {
  act(() => {
    fireEvent.keyDown(el, { key: 'v', code: 'KeyV', metaKey: true });
  });
}

beforeEach(() => {
  setLocale('zh');
  h.notifyError.mockClear();
  h.names = new Set(['a.txt', 'b.txt']);
  h.pending = [];
  vi.mocked(coApi.fs.copy).mockClear();
  Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useEditorStore.setState({ activeTabId: null });
  useExplorerClipboardStore.setState({ kind: 'copy', paths: ['/work/a.txt'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLocale('en');
  useExplorerClipboardStore.setState({ kind: null, paths: [] });
});

describe('粘贴进行中:延迟 500ms 出现的细进度条', () => {
  it('复制未完成满 500ms → 顶部 role=progressbar(带可访问名称);完成后消失;很快完成的不出现', async () => {
    const { el } = await focusRow('/work/b.txt');
    vi.useFakeTimers();
    paste(el);
    await flushAsync();
    expect(coApi.fs.copy).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(EXPLORER_PROGRESS_DELAY_MS - 1));
    expect(progress()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(progress()).not.toBeNull();
    expect(progress()!.getAttribute('aria-label')).toBe('正在执行文件操作…');
    h.pending.shift()!.resolve({ ok: true, data: undefined });
    await flushAsync();
    expect(progress()).toBeNull();

    // 很快完成的操作:不闪进度条
    paste(el);
    await flushAsync();
    act(() => vi.advanceTimersByTime(100));
    h.pending.shift()!.resolve({ ok: true, data: undefined });
    await flushAsync();
    act(() => vi.advanceTimersByTime(EXPLORER_PROGRESS_DELAY_MS));
    expect(progress()).toBeNull();
  });

  it('删除(移到废纸篓)进行中同样显示', async () => {
    const { el } = await focusRow('/work/b.txt');
    vi.useFakeTimers();
    act(() => {
      fireEvent.keyDown(el, { key: 'Delete', code: 'Delete' });
    });
    await flushAsync();
    expect(coApi.fs.trash).toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(EXPLORER_PROGRESS_DELAY_MS));
    expect(progress()).not.toBeNull();
    h.pending.shift()!.resolve({ ok: true, data: undefined });
    await flushAsync();
    expect(progress()).toBeNull();
  });
});

describe('上一批还在写时再粘贴', () => {
  it('第二次粘贴等第一批写完再挑名字 → `a copy 2.txt`(VSCode 同),不撞名报「已存在」', async () => {
    const { el } = await focusRow('/work/b.txt');
    paste(el);
    paste(el);
    await waitFor(() => expect(coApi.fs.copy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(coApi.fs.copy).mock.calls[0]![1]).toBe('/work/a copy.txt');
    await flushAsync();
    // 第一批未完成:第二批还没开始(未用旧目录快照挑名)
    expect(coApi.fs.copy).toHaveBeenCalledTimes(1);
    await act(async () => {
      h.pending.shift()!.resolve({ ok: true, data: undefined });
    });
    await waitFor(() => expect(coApi.fs.copy).toHaveBeenCalledTimes(2));
    expect(vi.mocked(coApi.fs.copy).mock.calls[1]![1]).toBe('/work/a copy 2.txt');
    await act(async () => {
      h.pending.shift()!.resolve({ ok: true, data: undefined });
    });
    expect(h.notifyError).not.toHaveBeenCalled();
  });
});

describe('不同目标目录的传输互不等待', () => {
  // VSCode 文件操作经 BulkEditService 各自执行、互不排队;本项目只把同一目标目录的批次串行(挑名要看到上一批写出的文件)。
  it('往 sub/ 的复制还没写完时往根目录粘贴 → 立即开始,不排在它后面', async () => {
    const { container } = await focusRow('/work/b.txt');
    act(() => {
      fireEvent.click(row(container, '/work/sub')!);
    });
    await waitFor(() => expect(row(container, '/work/sub')!.getAttribute('tabindex')).toBe('0'));
    paste(row(container, '/work/sub')!);
    await waitFor(() => expect(coApi.fs.copy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(coApi.fs.copy).mock.calls[0]![1]).toBe('/work/sub/a.txt');

    act(() => {
      fireEvent.click(row(container, '/work/b.txt')!);
    });
    await waitFor(() => expect(row(container, '/work/b.txt')!.getAttribute('tabindex')).toBe('0'));
    paste(row(container, '/work/b.txt')!);
    await waitFor(() => expect(coApi.fs.copy).toHaveBeenCalledTimes(2));
    expect(vi.mocked(coApi.fs.copy).mock.calls[1]![1]).toBe('/work/a copy.txt');
    await act(async () => {
      for (const d of h.pending.splice(0)) d.resolve({ ok: true, data: undefined });
    });
    expect(h.notifyError).not.toHaveBeenCalled();
  });
});

describe('失败文案只写名字', () => {
  it('粘贴失败 →「无法粘贴「a.txt」：…」,不含源的绝对路径', async () => {
    const { el } = await focusRow('/work/b.txt');
    paste(el);
    await waitFor(() => expect(coApi.fs.copy).toHaveBeenCalledTimes(1));
    await act(async () => {
      h.pending.shift()!.resolve({ ok: false, code: 'FS_DENIED', message: 'EACCES /work/a.txt' });
    });
    await waitFor(() => expect(h.notifyError).toHaveBeenCalled());
    const text = h.notifyError.mock.calls[0]![0] as string;
    expect(text).toBe('无法粘贴「a.txt」：拒绝访问');
    expect(text).not.toContain('/work/');
  });
});
