// @vitest-environment jsdom
// 文件树键盘操作(对齐 VSCode Explorer):焦点在树内时
//   - Enter:文件 → 打开(与单击同一 openFileByPath),打开成功后焦点进编辑器(VSCode explorer.openAndPassFocus);
//     目录 → 切换展开
//   - 方向键 / Home / End:选中跟随焦点(VSCode 列表 selectionNavigation)
//   - Delete(mac 另有 ⌘⌫):移到废纸篓,与右键「移到废纸篓」同一 onTrash;多选时作用于整组;
//     删除前弹确认(VSCode explorer.confirmDelete 默认开,初始焦点在「移到废纸篓」:可恢复,回车即执行),按住不放的自动重复不连删
//   - 未显示隐藏文件时,方向键 / Home / End 不会把焦点 / 选中落到看不见的 . 开头项(删不到它们)
//   - mod+C / mod+X / mod+V(mac ⌘、其它 Ctrl):与右键剪切 / 复制 / 粘贴同一实现;粘贴落点 = 焦点目录或焦点文件的父目录
//   - 键入字母:跳到名称以已键入前缀开头的下一项(VSCode type-to-navigate)
//   - 重命名输入框内的按键不触发上述任何动作
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const h = vi.hoisted(() => ({
  openFileByPath: null as null | ((p: string) => Promise<{ ok: true }>),
  editorFile: null as null | { openFileByPath: (p: string) => Promise<{ ok: true }> },
  settings: {} as Record<string, unknown>,
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
  useSettingValue: (key: string, fallback: unknown) => (key in h.settings ? h.settings[key] : fallback),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { coApi } from '@/lib/co-api';
import { useEditorStore } from '../../stores/editor.store';
import { registerEditorFocus } from '../../panels/Editor/editor-focus-registry';
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

const TRASH_LABEL = /^(移到废纸篓|Move to Trash)$/;
const CANCEL_LABEL = /^(取消|Cancel)$/;

/** 删除确认框弹出后点「移到废纸篓」。 */
async function confirmTrash(): Promise<HTMLElement> {
  const dialog = await screen.findByRole('alertdialog');
  act(() => {
    fireEvent.click(within(dialog).getByRole('button', { name: TRASH_LABEL }));
  });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  return dialog;
}

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  setPlatform('Win32');
  h.openFileByPath = vi.fn(async () => ({ ok: true as const }));
  h.editorFile = { openFileByPath: h.openFileByPath };
  vi.mocked(coApi.fs.trash).mockClear();
  vi.mocked(coApi.fs.copy).mockClear();
  h.settings = {};
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useExplorerClipboardStore.setState({ kind: null, paths: [] });
  // 活动编辑器是全局 store:上一用例打开的文件若留着,本用例挂载时 autoReveal 会去定位它,与用例自己的点击 / 按键竞争
  useEditorStore.setState({ activeTabId: null });
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

  it('Enter 打开文件成功 → 焦点交给编辑器(VSCode explorer.openAndPassFocus)', async () => {
    h.openFileByPath = vi.fn(async (p: string) => {
      useEditorStore.setState({ activeTabId: p });
      return { ok: true as const };
    });
    h.editorFile = { openFileByPath: h.openFileByPath };
    const focusEditor = vi.fn();
    const unregister = registerEditorFocus('/work/beta.ts', focusEditor);
    try {
      const { container } = await mount();
      await focusRow(container, '/work/beta.ts');
      // 单击打开(预览)不请求聚焦编辑器
      await new Promise((r) => setTimeout(r, 50));
      expect(focusEditor).not.toHaveBeenCalled();
      key(row(container, '/work/beta.ts')!, { key: 'Enter', code: 'Enter' });
      await waitFor(() => expect(focusEditor).toHaveBeenCalledTimes(1));
    } finally {
      unregister();
    }
  });

  it('Enter 打开文件失败 → 焦点留在树里,不请求聚焦编辑器', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/beta.ts');
    // 组件已挂载:改同一个 mock 的实现(换新函数不会被已渲染的回调看到)
    vi.mocked(h.openFileByPath!).mockClear();
    vi.mocked(h.openFileByPath!).mockImplementation(
      async () => ({ ok: false, code: 'FS_ENOENT', message: 'gone' }) as unknown as { ok: true },
    );
    useEditorStore.setState({ activeTabId: '/work/beta.ts' });
    const focusEditor = vi.fn();
    const unregister = registerEditorFocus('/work/beta.ts', focusEditor);
    try {
      key(row(container, '/work/beta.ts')!, { key: 'Enter', code: 'Enter' });
      await waitFor(() => expect(h.openFileByPath).toHaveBeenCalledWith('/work/beta.ts'));
      await new Promise((r) => setTimeout(r, 50));
      expect(focusEditor).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
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
    await confirmTrash();
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
    await confirmTrash();
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
    await confirmTrash();
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

describe('FolderTree · 删除确认(VSCode explorer.confirmDelete)', () => {
  it('Delete 先弹确认:单文件标题含文件名、说明可从废纸篓恢复,初始焦点在「移到废纸篓」(可恢复,回车即执行);取消 → 不删、选中不动', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/bravo.ts');
    key(row(container, '/work/bravo.ts')!, { key: 'Delete', code: 'Delete' });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/bravo\.ts/);
    expect(dialog.textContent).toMatch(/废纸篓|Trash/);
    const trashButton = within(dialog).getByRole('button', { name: TRASH_LABEL });
    await waitFor(() => expect(document.activeElement).toBe(trashButton));
    const cancel = within(dialog).getByRole('button', { name: CANCEL_LABEL });
    act(() => {
      fireEvent.click(cancel);
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(coApi.fs.trash).not.toHaveBeenCalled();
    expect(row(container, '/work/bravo.ts')!.getAttribute('aria-selected')).toBe('true');
  });

  it('多选删除:确认框列出 N 项', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/beta.ts');
    act(() => {
      fireEvent.click(row(container, '/work/charlie.ts')!, { ctrlKey: true });
    });
    await waitFor(() => expect(row(container, '/work/charlie.ts')!.getAttribute('aria-selected')).toBe('true'));
    key(row(container, '/work/charlie.ts')!, { key: 'Delete', code: 'Delete' });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/2/);
    expect(dialog.textContent).toMatch(/beta\.ts/);
    expect(dialog.textContent).toMatch(/charlie\.ts/);
  });

  it('按住 Delete 的自动重复(repeat)不弹确认、不删', async () => {
    const { container } = await mount();
    await focusRow(container, '/work/bravo.ts');
    key(row(container, '/work/bravo.ts')!, { key: 'Delete', code: 'Delete', repeat: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(coApi.fs.trash).not.toHaveBeenCalled();
  });

  it('右键「移到废纸篓」走同一确认框;确认后才删', async () => {
    const { container, findByText } = await mount();
    act(() => {
      fireEvent.contextMenu(row(container, '/work/beta.ts')!);
    });
    const item = await findByText(TRASH_LABEL);
    act(() => {
      fireEvent.click(item.closest('[role="menuitem"]')!);
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/beta\.ts/);
    expect(coApi.fs.trash).not.toHaveBeenCalled();
    await confirmTrash();
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledWith('/work/beta.ts'));
  });

  it('右键「移到废纸篓」→ 确认框打开期间焦点在框内;Esc 取消 → 焦点回到右键的那一行', async () => {
    const { container, findByText } = await mount();
    act(() => {
      fireEvent.contextMenu(row(container, '/work/bravo.ts')!);
    });
    const item = await findByText(TRASH_LABEL);
    act(() => {
      fireEvent.click(item.closest('[role="menuitem"]')!);
    });
    const dialog = await screen.findByRole('alertdialog');
    const trashButton = within(dialog).getByRole('button', { name: TRASH_LABEL });
    await waitFor(() => expect(document.activeElement).toBe(trashButton));
    // Radix 菜单关闭后的焦点还原(setTimeout)不得把焦点抢回遮罩后的树行
    await new Promise((r) => setTimeout(r, 30));
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/bravo.ts')));
    expect(coApi.fs.trash).not.toHaveBeenCalled();
  });

  it('右键「移到废纸篓」确认后 → 焦点落到下一项(不掉到 body)', async () => {
    const { container, findByText } = await mount();
    act(() => {
      fireEvent.contextMenu(row(container, '/work/bravo.ts')!);
    });
    const item = await findByText(TRASH_LABEL);
    act(() => {
      fireEvent.click(item.closest('[role="menuitem"]')!);
    });
    await confirmTrash();
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledWith('/work/bravo.ts'));
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/charlie.ts')));
  });

  it('explorer.confirmDelete 关闭 → 不弹确认直接移到废纸篓', async () => {
    h.settings = { 'explorer.confirmDelete': false };
    const { container } = await mount();
    await focusRow(container, '/work/bravo.ts');
    key(row(container, '/work/bravo.ts')!, { key: 'Delete', code: 'Delete' });
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledWith('/work/bravo.ts'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('FolderTree · 未显示隐藏文件时键盘不触及隐藏项', () => {
  const withHidden: FileEntry[] = [
    { path: '/work/.github', name: '.github', isDirectory: true },
    { path: '/work/.env', name: '.env', isDirectory: false },
    ...entries,
  ];
  beforeEach(() => {
    fsTree.set('/work', withHidden);
  });
  afterEach(() => {
    fsTree.set('/work', entries);
  });

  it('首个可见项上按 ArrowUp / Home 再 Delete → 删的是可见项,不是 .env / .github', async () => {
    const { container } = await mount();
    expect(row(container, '/work/.env')).toBeNull();
    await focusRow(container, '/work/alpha');
    key(row(container, '/work/alpha')!, { key: 'ArrowUp', code: 'ArrowUp' });
    keyUp(row(container, '/work/alpha')!, { key: 'ArrowUp', code: 'ArrowUp' });
    key(row(container, '/work/alpha')!, { key: 'Home', code: 'Home' });
    keyUp(row(container, '/work/alpha')!, { key: 'Home', code: 'Home' });
    key(row(container, '/work/alpha')!, { key: 'Delete', code: 'Delete' });
    await confirmTrash();
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalled());
    expect(vi.mocked(coApi.fs.trash).mock.calls.map((c) => c[0])).toEqual(['/work/alpha']);
  });

  it('关掉「显示隐藏文件」→ 选中集合里的隐藏项被移出:Delete / 复制只作用于仍可见的选中项', async () => {
    h.settings = { 'explorer.showHiddenFiles': true };
    const r = await mount();
    await waitFor(() => expect(row(r.container, '/work/.env')).not.toBeNull());
    await focusRow(r.container, '/work/.env');
    act(() => {
      fireEvent.click(row(r.container, '/work/beta.ts')!, { ctrlKey: true });
    });
    act(() => {
      fireEvent.click(row(r.container, '/work/charlie.ts')!, { ctrlKey: true });
    });
    await waitFor(() => expect(row(r.container, '/work/charlie.ts')!.getAttribute('aria-selected')).toBe('true'));
    h.settings = { 'explorer.showHiddenFiles': false };
    r.rerender(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/.env')).toBeNull());
    // 右键菜单按选中集合作用(不经键盘的防御过滤)→ 验证的是选中集合本身已修剪
    act(() => {
      fireEvent.contextMenu(row(r.container, '/work/charlie.ts')!);
    });
    const copyItem = await r.findByText(/^(复制|Copy)$/);
    act(() => {
      fireEvent.click(copyItem.closest('[role="menuitem"]')!);
    });
    expect([...useExplorerClipboardStore.getState().paths].sort()).toEqual([
      '/work/beta.ts',
      '/work/charlie.ts',
    ]);
    key(row(r.container, '/work/charlie.ts')!, { key: 'Delete', code: 'Delete' });
    await confirmTrash();
    await waitFor(() => expect(coApi.fs.trash).toHaveBeenCalledTimes(2));
    expect(vi.mocked(coApi.fs.trash).mock.calls.map((c) => c[0]).sort()).toEqual([
      '/work/beta.ts',
      '/work/charlie.ts',
    ]);
  });

  it('切换「显示隐藏文件」→ 已加载目录刷新,隐藏项出现;再关 → 消失', async () => {
    const r = await mount();
    expect(row(r.container, '/work/.env')).toBeNull();
    h.settings = { 'explorer.showHiddenFiles': true };
    r.rerender(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/.env')).not.toBeNull());
    h.settings = { 'explorer.showHiddenFiles': false };
    r.rerender(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/.env')).toBeNull());
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
