// @vitest-environment jsdom
// BDD:文件树里删除的撤销与撤销新建确认(README 规则 3、5;第五十五轮审计 B 组 #3)。
//   - 复制粘贴得到「beta copy.ts」,再删除另一个文件,然后 ⌘Z(Win Ctrl+Z)→ 被删的文件按删除前读回的内容在原位置重建
//    (不确认);再 ⌘Z → 才轮到撤销复制(弹确认),删除不再挡住更早的操作
//   - 没有删除时 ⌘Z 撤销复制 → 先弹确认(撤销会把文件移进废纸篓),初始焦点在「移到废纸篓」;确认后才移
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const entries: FileEntry[] = [
  { path: '/work/beta.ts', name: 'beta.ts', isDirectory: false },
  { path: '/work/bravo.ts', name: 'bravo.ts', isDirectory: false },
];
const fsTree = new Map<string, FileEntry[]>();
const resetTree = (): void => {
  fsTree.clear();
  fsTree.set('/work', [...entries]);
};

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: fsTree.get(p) ?? [] })),
      stat: vi.fn(async (p: string) =>
        p === '/work' || (fsTree.get('/work') ?? []).some((e) => e.path === p)
          ? { ok: true, data: { mtimeMs: 1, size: 0, ino: 1 } }
          : { ok: false, code: 'FS_NOT_FOUND', message: 'nf' },
      ),
      move: vi.fn(async () => ({ ok: true, data: undefined })),
      copy: vi.fn(async (_s: string, d: string) => {
        fsTree.set('/work', [...(fsTree.get('/work') ?? []), { path: d, name: d.slice(6), isDirectory: false }]);
        return { ok: true, data: undefined };
      }),
      trash: vi.fn(async (p: string) => {
        fsTree.set('/work', (fsTree.get('/work') ?? []).filter((e) => e.path !== p));
        return { ok: true, data: undefined };
      }),
      readForUndo: vi.fn(async () => ({ ok: true, data: { kind: 'file', content: new TextEncoder().encode('bravo!') } })),
      writeBinary: vi.fn(async (p: string) => {
        fsTree.set('/work', [...(fsTree.get('/work') ?? []), { path: p, name: p.slice(6), isDirectory: false }]);
        return { ok: true, data: undefined };
      }),
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
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: vi.fn(async () => ({ ok: true })) }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { coApi } from '@/lib/co-api';
import { useEditorStore } from '../../stores/editor.store';
import { FolderTree } from '../../panels/Explorer/FolderTree';
import { useExplorerClipboardStore } from '../../panels/Explorer/clipboard-store';
import { __resetFileUndoForTest } from '../../panels/Explorer/file-undo';

const COPY = '/work/beta copy.ts';
const TRASH_LABEL = /^(移到废纸篓|Move to Trash)$/;

const row = (container: HTMLElement, p: string) =>
  container.querySelector(`[title="${p}"]`) as HTMLElement | null;

let originalPlatform: PropertyDescriptor | undefined;

function key(el: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    fireEvent.keyDown(el, init);
  });
}

async function focusRow(container: HTMLElement, p: string) {
  act(() => {
    fireEvent.click(row(container, p)!);
  });
  await waitFor(() => expect(row(container, p)!.getAttribute('tabindex')).toBe('0'));
}

/** 挂载后在 beta.ts 上 Ctrl+C / Ctrl+V,得到「beta copy.ts」(入撤销栈)。 */
async function mountAndCopy() {
  const r = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row(r.container, '/work/beta.ts')).not.toBeNull());
  await focusRow(r.container, '/work/beta.ts');
  key(row(r.container, '/work/beta.ts')!, { key: 'c', code: 'KeyC', ctrlKey: true });
  key(row(r.container, '/work/beta.ts')!, { key: 'v', code: 'KeyV', ctrlKey: true });
  await waitFor(() => expect(coApi.fs.copy).toHaveBeenCalledWith('/work/beta.ts', COPY));
  await waitFor(() => expect(row(r.container, COPY)).not.toBeNull());
  return r;
}

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
  resetTree();
  __resetFileUndoForTest();
  vi.mocked(coApi.fs.trash).mockClear();
  vi.mocked(coApi.fs.copy).mockClear();
  vi.mocked(coApi.fs.readForUndo).mockClear();
  vi.mocked(coApi.fs.writeBinary).mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useExplorerClipboardStore.setState({ kind: null, paths: [] });
  useEditorStore.setState({ activeTabId: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalPlatform) Object.defineProperty(window.navigator, 'platform', originalPlatform);
  else delete (window.navigator as { platform?: string }).platform;
});

describe('删除后撤销:原位重建,不挡住更早的操作', () => {
  it('复制 → 删除另一个文件 → Ctrl+Z:按删除前读回的内容重建被删文件、不弹确认;再 Ctrl+Z 才撤销复制(弹确认)', async () => {
    const { container } = await mountAndCopy();
    await focusRow(container, '/work/bravo.ts');
    key(row(container, '/work/bravo.ts')!, { key: 'Delete', code: 'Delete' });
    const dialog = await screen.findByRole('alertdialog');
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: TRASH_LABEL }));
    });
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledWith('/work/bravo.ts'));
    // 删除前读回内容
    expect(vi.mocked(coApi.fs.readForUndo).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(coApi.fs.trash).mock.invocationCallOrder[0]!,
    );
    await waitFor(() => expect(row(container, '/work/bravo.ts')).toBeNull());
    await focusRow(container, COPY);

    key(row(container, COPY)!, { key: 'z', code: 'KeyZ', ctrlKey: true });
    await waitFor(() => expect(coApi.fs.writeBinary).toHaveBeenCalledTimes(1));
    const [path, content] = vi.mocked(coApi.fs.writeBinary).mock.calls[0]!;
    expect(path).toBe('/work/bravo.ts');
    expect(new TextDecoder().decode(content)).toBe('bravo!');
    await waitFor(() => expect(row(container, '/work/bravo.ts')).not.toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(coApi.fs.trash).toHaveBeenCalledTimes(1);

    key(row(container, '/work/bravo.ts')!, { key: 'z', code: 'KeyZ', ctrlKey: true });
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toMatch(/beta copy\.ts/);
  });
});

describe('撤销复制 / 新建:先确认', () => {
  it('复制后 Ctrl+Z → 弹确认(焦点在「移到废纸篓」);确认后才把复制出的文件移进废纸篓', async () => {
    const { container } = await mountAndCopy();
    key(row(container, COPY)!, { key: 'z', code: 'KeyZ', ctrlKey: true });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/beta copy\.ts/);
    const trashButton = within(dialog).getByRole('button', { name: TRASH_LABEL });
    await waitFor(() => expect(document.activeElement).toBe(trashButton));
    expect(coApi.fs.trash).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(trashButton);
    });
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledWith(COPY));
  });
});
