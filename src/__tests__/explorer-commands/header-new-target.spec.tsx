// @vitest-environment jsdom
// BDD:资源管理器标题栏「新建文件 / 新建文件夹」按钮与命令同一落点(VSCode:选中文件夹 → 建在里面;选中文件 →
// 建在所在目录;用户还没在树里移动过焦点 → 根)。见同目录 README 第 2 条。
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
// 标题栏只换成两颗直连 props 的按钮:本规范验的是 FolderTree 给按钮的落点,不是标题栏的样式 / 可见性。
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({
  ExplorerHeader: (p: { onNewFile?: () => void; onNewDir?: () => void }) => (
    <div>
      <button type="button" data-testid="hdr-new-file" onClick={p.onNewFile} />
      <button type="button" data-testid="hdr-new-dir" onClick={p.onNewDir} />
    </div>
  ),
}));

import { coApi } from '@/lib/co-api';
import { FolderTree } from '../../panels/Explorer/FolderTree';

const row = (p: string) => document.querySelector<HTMLElement>(`[title="${p}"]`);
const createInput = () => document.querySelector<HTMLInputElement>('input[placeholder]');

async function mount() {
  const r = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row('/work/beta.ts')).not.toBeNull());
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
  vi.mocked(coApi.fs.createFile).mockClear();
  vi.mocked(coApi.fs.createDir).mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
});
afterEach(() => {
  cleanup();
});

describe('资源管理器标题栏「新建文件 / 新建文件夹」落点', () => {
  it('树里选中文件夹 → 标题栏「新建文件」建在该文件夹里', async () => {
    const r = await mount();
    act(() => {
      fireEvent.click(row('/work/alpha')!);
    });
    act(() => {
      fireEvent.click(r.getByTestId('hdr-new-file'));
    });
    submit(await waitFor(() => createInput()!), 'n.ts');
    await waitFor(() => expect(coApi.fs.createFile).toHaveBeenCalledWith('/work/alpha', 'n.ts'));
  });

  it('树里选中文件 → 标题栏「新建文件夹」建在文件所在目录', async () => {
    fsTree.set('/work/alpha', [{ path: '/work/alpha/inner.ts', name: 'inner.ts', isDirectory: false }]);
    const r = await mount();
    act(() => {
      fireEvent.click(row('/work/alpha')!);
    });
    await waitFor(() => expect(row('/work/alpha/inner.ts')).not.toBeNull());
    act(() => {
      fireEvent.click(row('/work/alpha/inner.ts')!);
    });
    act(() => {
      fireEvent.click(r.getByTestId('hdr-new-dir'));
    });
    submit(await waitFor(() => createInput()!), 'd');
    await waitFor(() => expect(coApi.fs.createDir).toHaveBeenCalledWith('/work/alpha', 'd'));
  });

  it('用户还没在树里移动过焦点 → 建在根(与命令一致)', async () => {
    const r = await mount();
    act(() => {
      fireEvent.click(r.getByTestId('hdr-new-file'));
    });
    submit(await waitFor(() => createInput()!), 'r.ts');
    await waitFor(() => expect(coApi.fs.createFile).toHaveBeenCalledWith('/work', 'r.ts'));
  });
});
