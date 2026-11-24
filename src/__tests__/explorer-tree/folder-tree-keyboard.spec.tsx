// @vitest-environment jsdom
// 文件树键盘操作(对齐 VSCode Explorer):焦点在树内时
//   - Enter:文件 → 打开(与单击同一 openFileByPath);目录 → 切换展开
//   - 方向键 / Home / End:选中跟随焦点(VSCode 列表 selectionNavigation)
//   - Delete(mac 另有 ⌘⌫):移到废纸篓,与右键「移到废纸篓」同一 onTrash;多选时作用于整组
//   - mod+C / mod+X / mod+V(mac ⌘、其它 Ctrl):与右键剪切 / 复制 / 粘贴同一实现;粘贴落点 = 焦点目录或焦点文件的父目录
//   - 键入字母:跳到名称以已键入前缀开头的下一项(VSCode type-to-navigate)
//   - 重命名输入框内的按键不触发上述任何动作
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const h = vi.hoisted(() => ({
  openFileByPath: null as null | ((p: string) => Promise<{ ok: true }>),
  editorFile: null as null | { openFileByPath: (p: string) => Promise<{ ok: true }> },
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
      listDir: vi.fn(async (p: string) => ({ ok: true, data: fsTree.get(p) ?? [] })),
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
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { coApi } from '@/lib/co-api';
import { FolderTree } from '../../panels/Explorer/FolderTree';
import { useExplorerClipboardStore } from '../../panels/Explorer/clipboard-store';

const row = (container: HTMLElement, p: string) =>
  container.querySelector(`[title="${p}"]`) as HTMLElement | null;

let originalPlatform: PropertyDescriptor | undefined;
function setPlatform(p: string): void {
  Object.defineProperty(window.navigator, 'platform', { value: p, configurable: true });
}

async function mount() {
  const r = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row(r.container, '/work/beta.ts')).not.toBeNull());
  return r;
}

/** 单击某行(聚焦 + 选中),再在该行上按键。 */
async function focusRow(container: HTMLElement, p: string) {
  act(() => {
    fireEvent.click(row(container, p)!);
  });
  await waitFor(() => expect(row(container, p)!.getAttribute('tabindex')).toBe('0'));
}

function key(el: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    fireEvent.keyDown(el, init);
  });
}
function keyUp(el: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    fireEvent.keyUp(el, init);
  });
}

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  setPlatform('Win32');
  h.openFileByPath = vi.fn(async () => ({ ok: true as const }));
  h.editorFile = { openFileByPath: h.openFileByPath };
  vi.mocked(coApi.fs.trash).mockClear();
  vi.mocked(coApi.fs.copy).mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useExplorerClipboardStore.setState({ kind: null, paths: [] });
});
afterEach(() => {
  cleanup();
  if (originalPlatform) Object.defineProperty(window.navigator, 'platform', originalPlatform);
  else delete (window.navigator as { platform?: string }).platform;
});

describe('FolderTree · Enter 打开 / 切换展开', () => {
  it('焦点在文件上按 Enter → 打开该文件', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/beta.ts');
    vi.mocked(h.openFileByPath!).mockClear();
    key(row(container, '/work/beta.ts')!, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(h.openFileByPath).toHaveBeenCalledWith('/work/beta.ts'));
  });

  it('焦点在目录上按 Enter → 展开,再按 → 折叠,不打开文件', async () => {
    const { container } = await mount();
    // 键盘把焦点移到目录(不经单击:单击目录本身会切换展开)
    await focusRow(container, '/work/beta.ts');
    key(row(container, '/work/beta.ts')!, { key: 'ArrowUp', code: 'ArrowUp' });
    await waitFor(() => expect(row(container, '/work/alpha')!.getAttribute('tabindex')).toBe('0'));
    vi.mocked(h.openFileByPath!).mockClear();
    key(row(container, '/work/alpha')!, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(row(container, '/work/alpha')!.getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() => expect(row(container, '/work/alpha/inner.ts')).not.toBeNull());
    key(row(container, '/work/alpha')!, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(row(container, '/work/alpha')!.getAttribute('aria-expanded')).toBe('false'));
    expect(h.openFileByPath).not.toHaveBeenCalled();
  });
});

describe('FolderTree · 方向键选中跟随焦点', () => {
  it('ArrowDown / End / Home 移动焦点的同时把选中改为焦点项', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/beta.ts');
    key(row(container, '/work/beta.ts')!, { key: 'ArrowDown', code: 'ArrowDown' });
    await waitFor(() => expect(row(container, '/work/bravo.ts')!.getAttribute('aria-selected')).toBe('true'));
    expect(row(container, '/work/beta.ts')!.getAttribute('aria-selected')).toBe('false');
    keyUp(row(container, '/work/bravo.ts')!, { key: 'ArrowDown', code: 'ArrowDown' });
    key(row(container, '/work/bravo.ts')!, { key: 'End', code: 'End' });
    await waitFor(() => expect(row(container, '/work/charlie.ts')!.getAttribute('aria-selected')).toBe('true'));
    keyUp(row(container, '/work/charlie.ts')!, { key: 'End', code: 'End' });
    key(row(container, '/work/charlie.ts')!, { key: 'Home', code: 'Home' });
    await waitFor(() => expect(row(container, '/work/alpha')!.getAttribute('aria-selected')).toBe('true'));
    expect(row(container, '/work/charlie.ts')!.getAttribute('aria-selected')).toBe('false');
  });
});

describe('FolderTree · 删除 / 剪切 / 复制 / 粘贴热键(与右键菜单同一实现)', () => {
  it('Delete → 焦点项移到废纸篓,焦点与选中移到下一项', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/bravo.ts');
    key(row(container, '/work/bravo.ts')!, { key: 'Delete', code: 'Delete' });
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledWith('/work/bravo.ts'));
    expect(coApi.fs.trash).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(row(container, '/work/charlie.ts')!.getAttribute('aria-selected')).toBe('true'));
  });

  it('多选(Ctrl+单击)后 Delete → 整组移到废纸篓', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/beta.ts');
    act(() => {
      fireEvent.click(row(container, '/work/charlie.ts')!, { ctrlKey: true });
    });
    await waitFor(() => expect(row(container, '/work/charlie.ts')!.getAttribute('aria-selected')).toBe('true'));
    key(row(container, '/work/charlie.ts')!, { key: 'Delete', code: 'Delete' });
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledTimes(2));
    expect(vi.mocked(coApi.fs.trash).mock.calls.map((c) => c[0]).sort()).toEqual([
      '/work/beta.ts',
      '/work/charlie.ts',
    ]);
  });

  it('mac:⌘⌫ 移到废纸篓;单独 Backspace 不删', async () => {
    setPlatform('MacIntel');
    const { container } = await mount();
    await focusRow(container, '/work/beta.ts');
    key(row(container, '/work/beta.ts')!, { key: 'Backspace', code: 'Backspace' });
    keyUp(row(container, '/work/beta.ts')!, { key: 'Backspace', code: 'Backspace' });
    expect(coApi.fs.trash).not.toHaveBeenCalled();
    key(row(container, '/work/beta.ts')!, { key: 'Meta', code: 'MetaLeft', metaKey: true });
    key(row(container, '/work/beta.ts')!, { key: 'Backspace', code: 'Backspace', metaKey: true });
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledWith('/work/beta.ts'));
  });

  it('Ctrl+C 复制焦点项到应用内剪贴板,在目录上 Ctrl+V 粘贴进该目录', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/beta.ts');
    key(row(container, '/work/beta.ts')!, { key: 'c', code: 'KeyC', ctrlKey: true });
    expect(useExplorerClipboardStore.getState()).toMatchObject({ kind: 'copy', paths: ['/work/beta.ts'] });
    keyUp(row(container, '/work/beta.ts')!, { key: 'c', code: 'KeyC' });
    keyUp(row(container, '/work/beta.ts')!, { key: 'Control', code: 'ControlLeft' });
    key(row(container, '/work/beta.ts')!, { key: 'ArrowUp', code: 'ArrowUp' });
    keyUp(row(container, '/work/alpha')!, { key: 'ArrowUp', code: 'ArrowUp' });
    await waitFor(() => expect(row(container, '/work/alpha')!.getAttribute('tabindex')).toBe('0'));
    key(row(container, '/work/alpha')!, { key: 'v', code: 'KeyV', ctrlKey: true });
    await waitFor(() =>
      expect(coApi.fs.copy).toHaveBeenCalledWith('/work/beta.ts', '/work/alpha/beta.ts'),
    );
  });

  it('Ctrl+X 剪切;焦点在文件上 Ctrl+V 粘贴到该文件的父目录', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/beta.ts');
    key(row(container, '/work/beta.ts')!, { key: 'x', code: 'KeyX', ctrlKey: true });
    expect(useExplorerClipboardStore.getState()).toMatchObject({ kind: 'cut', paths: ['/work/beta.ts'] });
    useExplorerClipboardStore.setState({ kind: 'copy', paths: ['/work/alpha/inner.ts'] });
    keyUp(row(container, '/work/beta.ts')!, { key: 'x', code: 'KeyX' });
    key(row(container, '/work/beta.ts')!, { key: 'v', code: 'KeyV', ctrlKey: true });
    await waitFor(() =>
      expect(coApi.fs.copy).toHaveBeenCalledWith('/work/alpha/inner.ts', '/work/inner.ts'),
    );
  });

  it('mac:⌘C 之后(mac 不派发 C 的 keyup)方向键仍可导航', async () => {
    setPlatform('MacIntel');
    const { container } = await mount();
    await focusRow(container, '/work/beta.ts');
    key(row(container, '/work/beta.ts')!, { key: 'Meta', code: 'MetaLeft', metaKey: true });
    key(row(container, '/work/beta.ts')!, { key: 'c', code: 'KeyC', metaKey: true });
    expect(useExplorerClipboardStore.getState()).toMatchObject({ kind: 'copy', paths: ['/work/beta.ts'] });
    keyUp(row(container, '/work/beta.ts')!, { key: 'Meta', code: 'MetaLeft' });
    key(row(container, '/work/beta.ts')!, { key: 'ArrowDown', code: 'ArrowDown' });
    await waitFor(() => expect(row(container, '/work/bravo.ts')!.getAttribute('aria-selected')).toBe('true'));
  });
});

describe('FolderTree · 键入跳转(type-to-navigate)', () => {
  it('键入 b → 跳到下一项 b 开头;连续键入 br → bravo.ts;选中跟随', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/alpha');
    key(row(container, '/work/alpha')!, { key: 'b', code: 'KeyB' });
    await waitFor(() => expect(row(container, '/work/beta.ts')!.getAttribute('aria-selected')).toBe('true'));
    key(row(container, '/work/beta.ts')!, { key: 'r', code: 'KeyR' });
    await waitFor(() => expect(row(container, '/work/bravo.ts')!.getAttribute('aria-selected')).toBe('true'));
    expect(row(container, '/work/bravo.ts')!.getAttribute('tabindex')).toBe('0');
  });
});

describe('FolderTree · 输入框内按键不触发树热键', () => {
  it('重命名输入框里按 Delete / 字母 / Ctrl+C 不删除、不跳转、不写剪贴板', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/beta.ts');
    key(row(container, '/work/beta.ts')!, { key: 'F2', code: 'F2' });
    keyUp(row(container, '/work/beta.ts')!, { key: 'F2', code: 'F2' });
    const input = await waitFor(() => {
      const el = container.querySelector('input');
      expect(el).not.toBeNull();
      return el!;
    });
    key(input, { key: 'Delete', code: 'Delete' });
    key(input, { key: 'c', code: 'KeyC' });
    key(input, { key: 'c', code: 'KeyC', ctrlKey: true });
    expect(coApi.fs.trash).not.toHaveBeenCalled();
    expect(useExplorerClipboardStore.getState().kind).toBeNull();
    expect(row(container, '/work/charlie.ts')!.getAttribute('aria-selected')).toBe('false');
  });
});

describe('FolderTree · 选中随方向键高频变化后右键菜单仍按最新选中', () => {
  it('Ctrl+单击多选两项后右键其中一项 → 「移到废纸篓」作用于整组(显示 2 项)', async () => {
    const { container, findByText } = await mount();
    await focusRow(container, '/work/beta.ts');
    act(() => {
      fireEvent.click(row(container, '/work/charlie.ts')!, { ctrlKey: true });
    });
    await waitFor(() => expect(row(container, '/work/charlie.ts')!.getAttribute('aria-selected')).toBe('true'));
    act(() => {
      fireEvent.contextMenu(row(container, '/work/beta.ts')!);
    });
    const trash = await findByText(/Move to Trash|移到废纸篓/);
    expect(trash.closest('[role="menuitem"]')!.textContent).toMatch(/2/);
  });
});
