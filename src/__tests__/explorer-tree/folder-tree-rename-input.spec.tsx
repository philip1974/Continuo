// @vitest-environment jsdom
// 行内重命名(对齐 VSCode Explorer):
//   - F2 进入重命名:文件预选主名(不含最后一个扩展名),目录 / 无扩展名 / 以点开头的文件全选
//   - 输入框失焦 = 提交(VSCode 失焦时按当前值完成重命名),不是放弃
//   - Esc 放弃(之后的失焦不再提交);Enter 提交只发一次重命名
//   - Enter 提交成功 → 焦点与选中留在改名后的项(VSCode);失败 → 焦点回原项;失焦提交不把焦点拉回树
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
  { path: '/work/archive.tar.gz', name: 'archive.tar.gz', isDirectory: false },
  { path: '/work/Makefile', name: 'Makefile', isDirectory: false },
];
const initialTree = (): Map<string, FileEntry[]> => new Map<string, FileEntry[]>([
  ['/work', entries],
  ['/work/alpha', [{ path: '/work/alpha/inner.ts', name: 'inner.ts', isDirectory: false }]],
]);
const fsTree = initialTree();

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: fsTree.get(p) ?? [] })),
      move: vi.fn(async (_s: string, d: string) => ({ ok: true, data: d })),
      copy: vi.fn(async (_s: string, d: string) => ({ ok: true, data: d })),
      trash: vi.fn(async () => ({ ok: true, data: undefined })),
      // 成功:fsTree 里改名(随后父目录刷新能看到新项、旧项消失);失败由用例 mockResolvedValueOnce 覆盖
      rename: vi.fn(async (p: string, n: string) => {
        const newPath = `/work/${n}`;
        const list = fsTree.get('/work') ?? [];
        fsTree.set('/work', list.map((e) => (e.path === p ? { ...e, path: newPath, name: n } : e)));
        return { ok: true, data: newPath };
      }),
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
  vi.mocked(coApi.fs.rename).mockClear();
  vi.mocked(coApi.fs.copy).mockClear();
  fsTree.clear();
  for (const [k, v] of initialTree()) fsTree.set(k, v);
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useExplorerClipboardStore.setState({ kind: null, paths: [] });
});
afterEach(() => {
  cleanup();
  if (originalPlatform) Object.defineProperty(window.navigator, 'platform', originalPlatform);
  else delete (window.navigator as { platform?: string }).platform;
});

async function startRename(container: HTMLElement, p: string): Promise<HTMLInputElement> {
  await focusRow(container, p);
  key(row(container, p)!, { key: 'F2', code: 'F2' });
  keyUp(row(container, p)!, { key: 'F2', code: 'F2' });
  const input = await waitFor(() => {
    const el = container.querySelector('input');
    expect(el).not.toBeNull();
    return el!;
  });
  await waitFor(() => expect(document.activeElement).toBe(input));
  return input;
}

describe('FolderTree · F2 预选主名', () => {
  it.each([
    ['/work/beta.ts', 'beta.ts', 4],
    ['/work/archive.tar.gz', 'archive.tar.gz', 11],
    ['/work/Makefile', 'Makefile', 8],
    ['/work/alpha', 'alpha', 5],
  ])('%s → 选区 [0, %s 的主名末尾)', async (p, name, end) => {
    const { container } = await mount();
    const input = await startRename(container, p);
    expect(input.value).toBe(name);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(end);
  });
});

describe('FolderTree · 重命名失焦提交', () => {
  it('改名后失焦 → 按输入值重命名', async () => {
    const { container } = await mount();
    const input = await startRename(container, '/work/beta.ts');
    act(() => {
      fireEvent.change(input, { target: { value: 'gamma.ts' } });
    });
    act(() => {
      fireEvent.blur(input);
    });
    await waitFor(() => expect(coApi.fs.rename).toHaveBeenCalledWith('/work/beta.ts', 'gamma.ts'));
    await waitFor(() => expect(container.querySelector('input')).toBeNull());
  });

  it('点到树外别处(焦点移走)→ 提交,且焦点不被拉回树内', async () => {
    const { container } = await mount();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      const input = await startRename(container, '/work/beta.ts');
      act(() => {
        fireEvent.change(input, { target: { value: 'gamma.ts' } });
      });
      act(() => {
        outside.focus();
      });
      await waitFor(() => expect(coApi.fs.rename).toHaveBeenCalledWith('/work/beta.ts', 'gamma.ts'));
      await new Promise((r) => setTimeout(r, 50));
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it('Esc 放弃:不重命名(随后的失焦也不提交)', async () => {
    const { container } = await mount();
    const input = await startRename(container, '/work/beta.ts');
    act(() => {
      fireEvent.change(input, { target: { value: 'gamma.ts' } });
    });
    key(input, { key: 'Escape', code: 'Escape' });
    act(() => {
      fireEvent.blur(input);
    });
    await waitFor(() => expect(container.querySelector('input')).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(coApi.fs.rename).not.toHaveBeenCalled();
  });

  it('Enter 提交只发一次重命名(随后的失焦不重复提交)', async () => {
    const { container } = await mount();
    const input = await startRename(container, '/work/beta.ts');
    act(() => {
      fireEvent.change(input, { target: { value: 'gamma.ts' } });
    });
    key(input, { key: 'Enter', code: 'Enter' });
    act(() => {
      fireEvent.blur(input);
    });
    await waitFor(() => expect(coApi.fs.rename).toHaveBeenCalledWith('/work/beta.ts', 'gamma.ts'));
    await new Promise((r) => setTimeout(r, 20));
    expect(coApi.fs.rename).toHaveBeenCalledTimes(1);
  });
});

describe('FolderTree · 重命名后的焦点(VSCode:焦点与选中留在改名后的项)', () => {
  it('Enter 提交成功 → DOM 焦点与选中落在改名后的新项,不跳到首项', async () => {
    const { container } = await mount();
    const input = await startRename(container, '/work/beta.ts');
    act(() => {
      fireEvent.change(input, { target: { value: 'gamma.ts' } });
    });
    key(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(coApi.fs.rename).toHaveBeenCalledWith('/work/beta.ts', 'gamma.ts'));
    await waitFor(() => expect(row(container, '/work/gamma.ts')).not.toBeNull());
    expect(row(container, '/work/beta.ts')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/gamma.ts')));
    expect(row(container, '/work/gamma.ts')!.getAttribute('aria-selected')).toBe('true');
    // 库的 updateDomFocus 轮询(最多 500ms)结束后也不被打回首项
    await new Promise((r) => setTimeout(r, 600));
    expect(document.activeElement).toBe(row(container, '/work/gamma.ts'));
  });

  it('Enter 提交失败(同名冲突)→ 焦点回到原项', async () => {
    const { container } = await mount();
    vi.mocked(coApi.fs.rename).mockResolvedValueOnce({
      ok: false,
      code: 'FS_EEXIST',
      message: 'exists',
    } as never);
    const input = await startRename(container, '/work/beta.ts');
    act(() => {
      fireEvent.change(input, { target: { value: 'bravo.ts' } });
    });
    key(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(coApi.fs.rename).toHaveBeenCalledWith('/work/beta.ts', 'bravo.ts'));
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/beta.ts')));
    await new Promise((r) => setTimeout(r, 100));
    expect(document.activeElement).toBe(row(container, '/work/beta.ts'));
  });

  it('失焦提交(点到树外)成功 → 新项成为树的选中项,但 DOM 焦点留在树外', async () => {
    const { container } = await mount();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      const input = await startRename(container, '/work/beta.ts');
      act(() => {
        fireEvent.change(input, { target: { value: 'gamma.ts' } });
      });
      act(() => {
        outside.focus();
      });
      await waitFor(() => expect(row(container, '/work/gamma.ts')).not.toBeNull());
      await waitFor(() => expect(row(container, '/work/gamma.ts')!.getAttribute('aria-selected')).toBe('true'));
      await new Promise((r) => setTimeout(r, 50));
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});
