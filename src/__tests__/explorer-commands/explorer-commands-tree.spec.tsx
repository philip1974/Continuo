// @vitest-environment jsdom
// BDD:新建文件 / 新建文件夹 / 显示资源管理器 / 打开文件夹命令作用在资源管理器上(VSCode 同款):
//   - 新建:在树焦点项所在目录(目录 → 自身,文件 → 所在目录,无 → 根)打开 FolderTree 现有的新建输入框;侧栏隐藏 /
//     文件树尚未挂载时先显示侧栏,挂载后兑现
//   - 显示资源管理器:侧栏隐藏时打开,焦点进树的焦点行;无工作区时焦点到「打开文件夹」
//   - 打开文件夹(命令 / 空态按钮):选定后焦点交给新文件树(不掉到 body)
// 见同目录 README 第 3–5 条。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const entries: FileEntry[] = [
  { path: '/work/alpha', name: 'alpha', isDirectory: true },
  { path: '/work/beta.ts', name: 'beta.ts', isDirectory: false },
];
const fsTree = new Map<string, FileEntry[]>();

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: fsTree.get(p) ?? [] })),
      createFile: vi.fn(async (dir: string, name: string) => ({ ok: true, data: `${dir}/${name}` })),
      createDir: vi.fn(async (dir: string, name: string) => ({ ok: true, data: `${dir}/${name}` })),
      selectDirectory: vi.fn(async () => ({ ok: true, data: '/work' })),
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
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { coApi } from '@/lib/co-api';
import { __resetExplorerRequestsForTest } from '../../panels/Explorer/explorer-requests';
import { ExplorerSidebar } from '../../shell/ExplorerSidebar';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import {
  NEW_FILE_COMMAND_ID,
  NEW_FOLDER_COMMAND_ID,
  OPEN_FOLDER_COMMAND,
  SHOW_EXPLORER_COMMAND,
  explorerCommandSpecs,
} from '../../panels/Explorer/explorer-commands';
import { __resetSelectDirectoryLockForTest } from '../../lib/select-directory-single-flight';

const run = async (id: string): Promise<void> => {
  const spec = explorerCommandSpecs().find((c) => c.id === id);
  if (!spec) throw new Error(`no command ${id}`);
  await act(async () => {
    await spec.fn();
  });
};
const row = (p: string) => document.querySelector<HTMLElement>(`[title="${p}"]`);
const createInput = () => document.querySelector<HTMLInputElement>('input[placeholder]');
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

async function mountSidebar(root: string | null = '/work') {
  useWorkspaceStore.setState({ root });
  const r = render(<ExplorerSidebar />);
  if (root) await waitFor(() => expect(row('/work/beta.ts')).not.toBeNull());
  return r;
}

function submit(input: HTMLInputElement, value: string) {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  fsTree.clear();
  fsTree.set('/work', entries);
  fsTree.set('/work/alpha', []);
  __resetSelectDirectoryLockForTest();
  __resetExplorerRequestsForTest();
  vi.mocked(coApi.fs.createFile).mockClear();
  vi.mocked(coApi.fs.createDir).mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useLayoutUiStore.setState({ sidebarOpen: true });
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
});
afterEach(() => {
  cleanup();
});

describe('新建文件 / 新建文件夹命令', () => {
  it('树焦点在目录行 → 在该目录下打开新建文件输入框,提交后在该目录创建', async () => {
    await mountSidebar();
    act(() => {
      fireEvent.click(row('/work/alpha')!);
    });
    await run(NEW_FILE_COMMAND_ID);
    const input = await waitFor(() => createInput()!);
    expect(input.getAttribute('aria-label')).toMatch(/文件名|file name/i);
    submit(input, 'n.ts');
    await waitFor(() => expect(coApi.fs.createFile).toHaveBeenCalledWith('/work/alpha', 'n.ts'));
  });

  it('树焦点在文件行 → 在文件所在目录新建文件夹', async () => {
    await mountSidebar();
    act(() => {
      fireEvent.click(row('/work/beta.ts')!);
    });
    await run(NEW_FOLDER_COMMAND_ID);
    const input = await waitFor(() => createInput()!);
    expect(input.getAttribute('aria-label')).toMatch(/文件夹|folder/i);
    submit(input, 'd');
    await waitFor(() => expect(coApi.fs.createDir).toHaveBeenCalledWith('/work', 'd'));
  });

  it('树没有焦点项 → 在工作区根新建', async () => {
    await mountSidebar();
    await run(NEW_FILE_COMMAND_ID);
    submit(await waitFor(() => createInput()!), 'r.ts');
    await waitFor(() => expect(coApi.fs.createFile).toHaveBeenCalledWith('/work', 'r.ts'));
  });

  it('侧栏隐藏(启动即关闭,文件树尚未挂载)→ 先显示侧栏,文件树挂载后打开输入框并获焦', async () => {
    useLayoutUiStore.setState({ sidebarOpen: false });
    useWorkspaceStore.setState({ root: '/work' });
    render(<ExplorerSidebar />);
    expect(document.querySelector('aside')).toBeNull();
    await run(NEW_FILE_COMMAND_ID);
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
    const input = await waitFor(() => createInput()!);
    await nextFrame();
    expect(document.activeElement).toBe(input);
  });

  it('没有工作区 → 不出输入框,显示资源管理器并聚焦「打开文件夹」', async () => {
    useLayoutUiStore.setState({ sidebarOpen: false });
    render(<ExplorerSidebar />);
    await run(NEW_FILE_COMMAND_ID);
    await nextFrame();
    expect(createInput()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-open-folder]'));
  });
});

describe('显示资源管理器(⌘⇧E)', () => {
  it('侧栏已隐藏 → 打开侧栏,焦点进树的焦点行', async () => {
    await mountSidebar();
    act(() => useLayoutUiStore.setState({ sidebarOpen: false }));
    expect(document.querySelector('aside')!.hidden).toBe(true);
    await run(SHOW_EXPLORER_COMMAND.id);
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('treeitem'));
    expect(document.querySelector('aside')!.hidden).toBe(false);
  });
});

describe('打开文件夹', () => {
  it('命令:选定后工作区根切换,焦点交给新文件树(VSCode:打开文件夹后焦点在资源管理器)', async () => {
    useLayoutUiStore.setState({ sidebarOpen: false });
    render(<ExplorerSidebar />);
    await run(OPEN_FOLDER_COMMAND.id);
    expect(useWorkspaceStore.getState().root).toBe('/work');
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('treeitem'));
  });

  it('空态「打开文件夹」按钮:同样焦点交给新文件树,不掉到 body', async () => {
    await mountSidebar(null);
    const button = document.querySelector<HTMLButtonElement>('[data-open-folder]')!;
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('treeitem'));
  });

  it('取消选择 → 工作区与焦点不变', async () => {
    vi.mocked(coApi.fs.selectDirectory).mockResolvedValueOnce({ ok: true, data: null } as never);
    await mountSidebar(null);
    const button = document.querySelector<HTMLButtonElement>('[data-open-folder]')!;
    button.focus();
    await run(OPEN_FOLDER_COMMAND.id);
    expect(useWorkspaceStore.getState().root).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
