// @vitest-environment jsdom
// 文件树列表为空时区分三态(VSCode Explorer:加载中显示进度、空文件夹显示空态、读取失败显示原因):
//   - 根目录还在读取 → 「加载中」
//   - 读取成功但没有可显示的项 → 「此文件夹为空」
//   - 读取失败 → 本地化的失败原因 + 「重试」按钮(调与 Header 刷新同一实现);重试成功后列出文件
//   - 根目录读取失败只走内联提示(不再另弹 toast,读屏不重复播报);子目录读取失败仍 toast
//   - 点「重试」后焦点不掉到 body:成功 → 树内焦点行;仍失败 → 新的「重试」按钮
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const h = vi.hoisted(() => ({
  // 根目录 listDir 的结果由用例控制(pending / 成功 / 失败);null = 用 fsTree
  rootListDir: null as null | (() => Promise<unknown>),
  openFileByPath: null as null | ((p: string) => Promise<{ ok: true }>),
  editorFile: null as null | { openFileByPath: (p: string) => Promise<{ ok: true }> },
  settings: {} as Record<string, unknown>,
  // 读取失败的目录(EACCES 等,main 已映射为 FS_DENIED)
  failDirs: new Set<string>(),
}));

const entries: FileEntry[] = [
  { path: '/work/alpha', name: 'alpha', isDirectory: true },
  { path: '/work/beta.ts', name: 'beta.ts', isDirectory: false },
  { path: '/work/bravo.ts', name: 'bravo.ts', isDirectory: false },
  { path: '/work/charlie.ts', name: 'charlie.ts', isDirectory: false },
];
const fsTree = new Map<string, FileEntry[]>([
  ['/work', entries],
  ['/work/alpha', [{ path: '/work/alpha/inner.ts', name: 'inner.ts', isDirectory: false }]],
]);

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) =>
        h.failDirs.has(p)
          ? { ok: false, code: 'FS_DENIED', message: `EACCES: permission denied, opendir '${p}'` }
          : p === '/work' && h.rootListDir
            ? h.rootListDir()
            : { ok: true, data: fsTree.get(p) ?? [] },
      ),
      move: vi.fn(async (_s: string, d: string) => ({ ok: true, data: d })),
      copy: vi.fn(async (_s: string, d: string) => ({ ok: true, data: d })),
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
  useEditorFile: () => h.editorFile,
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (key: string, fallback: unknown) => (key in h.settings ? h.settings[key] : fallback),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { FolderTree } from '../../panels/Explorer/FolderTree';
import { useExplorerClipboardStore } from '../../panels/Explorer/clipboard-store';

const row = (container: HTMLElement, p: string) =>
  container.querySelector(`[title="${p}"]`) as HTMLElement | null;

let originalPlatform: PropertyDescriptor | undefined;
function setPlatform(p: string): void {
  Object.defineProperty(window.navigator, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  setPlatform('Win32');
  h.openFileByPath = vi.fn(async () => ({ ok: true as const }));
  h.editorFile = { openFileByPath: h.openFileByPath };
  vi.mocked(coApi.fs.listDir).mockClear();
  h.rootListDir = null;
  h.settings = {};
  h.failDirs = new Set();
  vi.mocked(coApi.fs.copy).mockClear();
  vi.spyOn(notify, 'error').mockImplementation(() => '');
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useExplorerClipboardStore.setState({ kind: null, paths: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalPlatform) Object.defineProperty(window.navigator, 'platform', originalPlatform);
  else delete (window.navigator as { platform?: string }).platform;
});

const LOADING = /^(加载中|Loading)$/;
const EMPTY = /^(此文件夹为空|This folder is empty)$/;
const RETRY = /^(重试|Retry)$/;

describe('FolderTree · 空列表三态', () => {
  it('根目录读取中 → 显示「加载中」,不显示空目录', async () => {
    h.rootListDir = () => new Promise(() => {});
    const r = render(<FolderTree root="/work" />);
    expect(await r.findByText(LOADING)).toBeTruthy();
    expect(r.queryByText(EMPTY)).toBeNull();
    expect(r.queryByRole('alert')).toBeNull();
  });

  it('读取成功且为空 → 显示「此文件夹为空」', async () => {
    h.rootListDir = async () => ({ ok: true, data: [] });
    const r = render(<FolderTree root="/work" />);
    expect(await r.findByText(EMPTY)).toBeTruthy();
    expect(r.queryByText(LOADING)).toBeNull();
    expect(r.queryByRole('alert')).toBeNull();
  });

  it('读取失败 → 显示本地化原因与「重试」;重试成功后列出文件', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'EACCES: permission denied' });
    const r = render(<FolderTree root="/work" />);
    const alert = await r.findByRole('alert');
    expect(alert.textContent).toMatch(/拒绝访问|Access denied/);
    expect(r.queryByText(EMPTY)).toBeNull();
    const calls = vi.mocked(coApi.fs.listDir).mock.calls.filter((c) => c[0] === '/work').length;
    h.rootListDir = null;
    act(() => {
      fireEvent.click(r.getByRole('button', { name: RETRY }));
    });
    await waitFor(() => expect(row(r.container, '/work/beta.ts')).not.toBeNull());
    expect(vi.mocked(coApi.fs.listDir).mock.calls.filter((c) => c[0] === '/work').length).toBeGreaterThan(calls);
    expect(r.queryByRole('alert')).toBeNull();
  });
});

describe('FolderTree · 读取失败反馈', () => {
  it('根目录读取失败 → 只有一处 role=alert 的内联提示,不另弹 toast', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'EACCES: permission denied' });
    const r = render(<FolderTree root="/work" />);
    await r.findByRole('alert');
    await new Promise((res) => setTimeout(res, 20));
    expect(r.getAllByRole('alert')).toHaveLength(1);
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('子目录读取失败 → 该目录下内联错误行(本地化原因 + 重试),不弹 toast', async () => {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    h.failDirs.add('/work/alpha');
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    const alert = await r.findByRole('alert');
    expect(alert.textContent).toMatch(/拒绝访问|Access denied/);
    expect(alert.textContent).not.toMatch(/EACCES|listDir|\/work/);
    // 错误行紧跟在失败目录之后
    const tree = r.container.querySelector('[role="tree"]')!;
    expect(tree.contains(alert)).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('子目录错误行「重试」成功 → 列出子项、错误行消失,焦点回到该目录行', async () => {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    h.failDirs.add('/work/alpha');
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    await r.findByRole('alert');
    h.failDirs.delete('/work/alpha');
    const retry = r.getByRole('button', { name: RETRY });
    retry.focus();
    act(() => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(row(r.container, '/work/alpha/inner.ts')).not.toBeNull());
    expect(r.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row(r.container, '/work/alpha')));
  });

  it('已折叠目录在后台刷新时读取失败 → toast 按错误码本地化并带目录名,不含原始诊断串', async () => {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    await waitFor(() => expect(row(r.container, '/work/alpha/inner.ts')).not.toBeNull());
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    await waitFor(() => expect(row(r.container, '/work/alpha/inner.ts')).toBeNull());
    h.failDirs.add('/work/alpha');
    // 切换「显示隐藏文件」刷新全部已加载目录(含已折叠的 alpha)
    h.settings = { 'explorer.showHiddenFiles': true };
    r.rerender(<FolderTree root="/work" />);
    await waitFor(() => expect(notify.error).toHaveBeenCalled());
    const text = vi.mocked(notify.error).mock.calls[0]![0];
    expect(text).toMatch(/alpha/);
    expect(text).toMatch(/拒绝访问|Access denied/);
    expect(text).not.toMatch(/EACCES|listDir|\/work\/alpha/);
  });
});

describe('FolderTree · 重试后的焦点', () => {
  it('重试成功 → 焦点移到树内焦点行(不掉到 body)', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'denied' });
    const r = render(<FolderTree root="/work" />);
    const retry = await r.findByRole('button', { name: RETRY });
    retry.focus();
    h.rootListDir = null;
    act(() => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.closest('[role="tree"]')).not.toBeNull();
    });
  });

  it('重试成功但根目录为空 → 焦点落到空态提示;之后根目录出现文件也不把焦点从别处拉回树', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'denied' });
    const r = render(<FolderTree root="/work" />);
    const retry = await r.findByRole('button', { name: RETRY });
    retry.focus();
    h.rootListDir = async () => ({ ok: true, data: [] });
    act(() => {
      fireEvent.click(retry);
    });
    const empty = await r.findByText(EMPTY);
    await waitFor(() => expect(document.activeElement).toBe(empty));
    // 用户把焦点移到别处(编辑器 / 终端)
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    // 根目录随后出现文件(刷新全部已加载目录)
    h.rootListDir = null;
    h.settings = { 'explorer.showHiddenFiles': true };
    r.rerender(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/beta.ts')).not.toBeNull());
    await new Promise((res) => setTimeout(res, 30));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('重试仍失败 → 焦点落在新的「重试」按钮', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'denied' });
    const r = render(<FolderTree root="/work" />);
    const retry = await r.findByRole('button', { name: RETRY });
    retry.focus();
    act(() => {
      fireEvent.click(retry);
    });
    await waitFor(() => {
      const again = r.getByRole('button', { name: RETRY });
      expect(document.activeElement).toBe(again);
    });
  });
});
