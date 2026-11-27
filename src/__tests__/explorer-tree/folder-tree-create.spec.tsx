// @vitest-environment jsdom
// 新建文件 / 文件夹(对齐 VSCode Explorer):
//   - 成功:父目录展开,新项被选中并获得树焦点;新建文件随即在编辑器打开且 DOM 焦点进入编辑器(VSCode 新建
//     文件后直接打开并可接着输入),新建文件夹则焦点留在树里、落在新文件夹上
//   - 失败(含同名冲突):输入框不关、已输入的名字保留,输入框下方显示本地化的错误原因(VSCode 的内联校验
//     提示);修改名字后错误消失,可直接重试;Esc 放弃
//   - 放弃(Esc / ✕ / 空名 Enter)→ 焦点回到树的焦点行(VSCode:取消后焦点回资源管理器树),不掉到 body
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
const initialTree = (): Map<string, FileEntry[]> => new Map<string, FileEntry[]>([
  ['/work', entries],
  ['/work/alpha', [{ path: '/work/alpha/inner.ts', name: 'inner.ts', isDirectory: false }]],
]);
const fsTree = initialTree();

/**
 * 假 fs 的新建(同 main createFile / createDir):name 可带中间目录(`a/b/c.ts`),缺的逐级建出;返回 path 与 created
 *(本次新建的最上层项)。成功后写进 fsTree,随后的 listDir 能看到。失败由用例 mockResolvedValueOnce 覆盖。
 */
function createIn(dir: string, name: string, isDirectory: boolean) {
  const segs = name.split('/');
  let cur = dir;
  let created: string | null = null;
  segs.forEach((seg, i) => {
    const path = `${cur}/${seg}`;
    const last = i === segs.length - 1;
    const siblings = fsTree.get(cur) ?? [];
    if (!siblings.some((e) => e.path === path)) {
      const isDir = last ? isDirectory : true;
      fsTree.set(cur, [...siblings, { path, name: seg, isDirectory: isDir }]);
      if (isDir) fsTree.set(path, []);
      created ??= path;
    }
    cur = path;
  });
  return { ok: true, data: { path: cur, created: created ?? cur } };
}

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: fsTree.get(p) ?? [] })),
      move: vi.fn(async (_s: string, d: string) => ({ ok: true, data: d })),
      copy: vi.fn(async (_s: string, d: string) => ({ ok: true, data: d })),
      trash: vi.fn(async () => ({ ok: true, data: undefined })),
      // 成功:把新项写进 fsTree(随后的 listDir 能看到);失败由用例 mockResolvedValueOnce 覆盖
      createFile: vi.fn(async (dir: string, name: string) => createIn(dir, name, false)),
      createDir: vi.fn(async (dir: string, name: string) => createIn(dir, name, true)),
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
import { useEditorStore } from '../../stores/editor.store';
import { registerEditorFocus } from '../../panels/Editor/editor-focus-registry';
import { FolderTree } from '../../panels/Explorer/FolderTree';
import { useExplorerClipboardStore } from '../../panels/Explorer/clipboard-store';
import { requestExplorer } from '../../panels/Explorer/explorer-requests';

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

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  setPlatform('Win32');
  h.openFileByPath = vi.fn(async () => ({ ok: true as const }));
  h.editorFile = { openFileByPath: h.openFileByPath };
  vi.mocked(coApi.fs.createFile).mockClear();
  vi.mocked(coApi.fs.createDir).mockClear();
  fsTree.clear();
  for (const [k, v] of initialTree()) fsTree.set(k, v);
  vi.mocked(coApi.fs.copy).mockClear();
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

const NEW_FILE = /^(新建文件|New File)$/;
const NEW_FOLDER = /^(新建文件夹|New Folder)$/;

async function startCreateIn(
  r: Awaited<ReturnType<typeof mount>>,
  dirRow: string,
  item: RegExp,
): Promise<HTMLInputElement> {
  act(() => {
    fireEvent.contextMenu(row(r.container, dirRow)!);
  });
  const menuItem = await r.findByText(item);
  act(() => {
    fireEvent.click(menuItem);
  });
  return (await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('input[placeholder]');
    expect(el).not.toBeNull();
    return el!;
  }))!;
}

function submit(input: HTMLInputElement, value: string) {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

describe('FolderTree · 新建成功后展开父目录、选中并打开', () => {
  it('在折叠目录里新建文件 → 目录展开,新文件被选中 / 聚焦,并在编辑器打开且焦点进编辑器', async () => {
    // 打开即成为活动 tab(真实 openFileByPath 的效果);编辑器就绪后登记的聚焦句柄应被调用
    h.openFileByPath = vi.fn(async (p: string) => {
      useEditorStore.setState({ activeTabId: p });
      return { ok: true as const };
    });
    h.editorFile = { openFileByPath: h.openFileByPath };
    const focusEditor = vi.fn();
    const unregister = registerEditorFocus('/work/alpha/new.ts', focusEditor);
    const r = await mount();
    expect(row(r.container, '/work/alpha')!.getAttribute('aria-expanded')).toBe('false');
    const input = await startCreateIn(r, '/work/alpha', NEW_FILE);
    submit(input, 'new.ts');
    await waitFor(() => expect(coApi.fs.createFile).toHaveBeenCalledWith('/work/alpha', 'new.ts'));
    await waitFor(() => expect(h.openFileByPath).toHaveBeenCalledWith('/work/alpha/new.ts', undefined));
    await waitFor(() => expect(row(r.container, '/work/alpha/new.ts')).not.toBeNull());
    expect(row(r.container, '/work/alpha')!.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(row(r.container, '/work/alpha/new.ts')!.getAttribute('aria-selected')).toBe('true'));
    expect(row(r.container, '/work/alpha/new.ts')!.getAttribute('tabindex')).toBe('0');
    expect(document.querySelector('input[placeholder]')).toBeNull();
    await waitFor(() => expect(focusEditor).toHaveBeenCalledTimes(1));
    unregister();
  });

  it('普通单击打开已有文件 → 焦点留在树里,不请求聚焦编辑器(VSCode 单击预览同款)', async () => {
    h.openFileByPath = vi.fn(async (p: string) => {
      useEditorStore.setState({ activeTabId: p });
      return { ok: true as const };
    });
    h.editorFile = { openFileByPath: h.openFileByPath };
    const focusEditor = vi.fn();
    const unregister = registerEditorFocus('/work/beta.ts', focusEditor);
    const r = await mount();
    act(() => {
      fireEvent.click(row(r.container, '/work/beta.ts')!);
    });
    await waitFor(() => expect(h.openFileByPath).toHaveBeenCalledWith('/work/beta.ts', { preview: true }));
    await new Promise((res) => setTimeout(res, 50));
    expect(focusEditor).not.toHaveBeenCalled();
    unregister();
  });

  it('双击打开已有文件 → 打开后焦点进编辑器(VSCode 双击 = 打开并聚焦编辑器)', async () => {
    h.openFileByPath = vi.fn(async (p: string) => {
      useEditorStore.setState({ activeTabId: p });
      return { ok: true as const };
    });
    h.editorFile = { openFileByPath: h.openFileByPath };
    const focusEditor = vi.fn();
    const unregister = registerEditorFocus('/work/beta.ts', focusEditor);
    const r = await mount();
    const target = row(r.container, '/work/beta.ts')!;
    // 浏览器双击的事件序列:click(detail 1)→ click(detail 2)→ dblclick
    act(() => {
      fireEvent.click(target, { detail: 1 });
      fireEvent.click(target, { detail: 2 });
      fireEvent.doubleClick(target, { detail: 2 });
    });
    await waitFor(() => expect(focusEditor).toHaveBeenCalledTimes(1));
    unregister();
  });

  it('双击打开失败 → 不请求聚焦编辑器', async () => {
    h.openFileByPath = vi.fn(async () => ({ ok: false, code: 'FS_ENOENT', message: 'gone' }) as unknown as { ok: true });
    h.editorFile = { openFileByPath: h.openFileByPath };
    useEditorStore.setState({ activeTabId: '/work/beta.ts' });
    const focusEditor = vi.fn();
    const unregister = registerEditorFocus('/work/beta.ts', focusEditor);
    const r = await mount();
    const target = row(r.container, '/work/beta.ts')!;
    act(() => {
      fireEvent.click(target, { detail: 1 });
      fireEvent.click(target, { detail: 2 });
      fireEvent.doubleClick(target, { detail: 2 });
    });
    await waitFor(() => expect(h.openFileByPath).toHaveBeenCalled());
    await new Promise((res) => setTimeout(res, 50));
    expect(focusEditor).not.toHaveBeenCalled();
    unregister();
  });

  it('新建文件夹 → 新文件夹被选中且 DOM 焦点落在该行,不打开任何文件', async () => {
    const r = await mount();
    const input = await startCreateIn(r, '/work/alpha', NEW_FOLDER);
    submit(input, 'sub');
    await waitFor(() => expect(coApi.fs.createDir).toHaveBeenCalledWith('/work/alpha', 'sub'));
    await waitFor(() => expect(row(r.container, '/work/alpha/sub')).not.toBeNull());
    await waitFor(() => expect(row(r.container, '/work/alpha/sub')!.getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(row(r.container, '/work/alpha/sub')));
    expect(h.openFileByPath).not.toHaveBeenCalled();
  });
});

describe('FolderTree · 新建时输入嵌套路径(VSCode 同款逐级创建)', () => {
  it('新建文件输入 na/nb/nc.ts → 整串交给 fs(逐级创建),逐级展开到新文件、选中并打开', async () => {
    h.openFileByPath = vi.fn(async (p: string) => {
      useEditorStore.setState({ activeTabId: p });
      return { ok: true as const };
    });
    h.editorFile = { openFileByPath: h.openFileByPath };
    const r = await mount();
    const input = await startCreateIn(r, '/work/alpha', NEW_FILE);
    submit(input, 'na/nb/nc.ts');
    await waitFor(() => expect(coApi.fs.createFile).toHaveBeenCalledWith('/work/alpha', 'na/nb/nc.ts'));
    await waitFor(() => expect(h.openFileByPath).toHaveBeenCalledWith('/work/alpha/na/nb/nc.ts', undefined));
    await waitFor(() => expect(row(r.container, '/work/alpha/na/nb/nc.ts')).not.toBeNull());
    for (const dir of ['/work/alpha', '/work/alpha/na', '/work/alpha/na/nb']) {
      expect(row(r.container, dir)!.getAttribute('aria-expanded')).toBe('true');
    }
    await waitFor(() =>
      expect(row(r.container, '/work/alpha/na/nb/nc.ts')!.getAttribute('aria-selected')).toBe('true'),
    );
    expect(document.querySelector('input[placeholder]')).toBeNull();
  });

  it('新建文件夹输入 a/b → 逐级创建,展开到 b 并选中,不打开文件', async () => {
    const r = await mount();
    const input = await startCreateIn(r, '/work/alpha', NEW_FOLDER);
    submit(input, 'a/b');
    await waitFor(() => expect(coApi.fs.createDir).toHaveBeenCalledWith('/work/alpha', 'a/b'));
    await waitFor(() => expect(row(r.container, '/work/alpha/a/b')).not.toBeNull());
    expect(row(r.container, '/work/alpha/a')!.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(row(r.container, '/work/alpha/a/b')!.getAttribute('aria-selected')).toBe('true'));
    expect(h.openFileByPath).not.toHaveBeenCalled();
  });
});

describe('FolderTree · 新建失败保留输入并内联提示', () => {
  it('同名冲突 → 输入框与名字保留,下方显示本地化原因;改名后错误消失并可重试', async () => {
    const r = await mount();
    vi.mocked(coApi.fs.createFile).mockResolvedValueOnce({
      ok: false,
      code: 'FS_EEXIST',
      message: 'EEXIST: file already exists',
    } as never);
    const input = await startCreateIn(r, '/work/alpha', NEW_FILE);
    submit(input, 'inner.ts');
    const alert = await r.findByRole('alert');
    expect(alert.textContent).toMatch(/已存在|Already exists/);
    const still = document.querySelector<HTMLInputElement>('input[placeholder]')!;
    expect(still).not.toBeNull();
    expect(still.value).toBe('inner.ts');
    expect(still.getAttribute('aria-invalid')).toBe('true');
    expect(h.openFileByPath).not.toHaveBeenCalled();

    submit(still, 'inner2.ts');
    await waitFor(() => expect(coApi.fs.createFile).toHaveBeenLastCalledWith('/work/alpha', 'inner2.ts'));
    await waitFor(() => expect(document.querySelector('input[placeholder]')).toBeNull());
    expect(r.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(h.openFileByPath).toHaveBeenCalledWith('/work/alpha/inner2.ts', undefined));
  });

  it('失败后 Esc → 放弃新建,输入框与错误一并消失', async () => {
    const r = await mount();
    vi.mocked(coApi.fs.createFile).mockResolvedValueOnce({
      ok: false,
      code: 'FS_EEXIST',
      message: 'exists',
    } as never);
    const input = await startCreateIn(r, '/work/alpha', NEW_FILE);
    submit(input, 'inner.ts');
    await r.findByRole('alert');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(document.querySelector('input[placeholder]')).toBeNull());
    expect(r.queryByRole('alert')).toBeNull();
  });
});

describe('FolderTree · 放弃新建后焦点回树', () => {
  const CANCEL = /^(取消|Cancel)$/;
  const keydown = (input: HTMLInputElement, key: string) =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it.each(['Esc', '空名 Enter', '点 ✕'])('%s 放弃 → DOM 焦点落在树的焦点行(右键所在行)', async (how) => {
    const r = await mount();
    const input = await startCreateIn(r, '/work/alpha', NEW_FILE);
    await waitFor(() => expect(document.activeElement).toBe(input));
    act(() => {
      if (how === 'Esc') keydown(input, 'Escape');
      else if (how === '空名 Enter') keydown(input, 'Enter');
      else fireEvent.click(r.getByRole('button', { name: CANCEL }));
    });
    await waitFor(() => expect(document.querySelector('input[placeholder]')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row(r.container, '/work/alpha')));
    expect(coApi.fs.createFile).not.toHaveBeenCalled();
  });
});

describe('FolderTree · 再次新建与失焦(VSCode 行内输入框同款)', () => {
  const input = () => document.querySelector<HTMLInputElement>('input[placeholder]');
  /** 树外的可聚焦元素(编辑器的替身)。 */
  function outside(): HTMLButtonElement {
    const b = document.body.appendChild(document.createElement('button'));
    b.textContent = 'editor';
    return b;
  }
  const flush = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

  it('输入条开着时再新建(换类型)→ 输入条换成新的:清空、类型随之改变,且焦点进新输入框', async () => {
    const r = await mount();
    const first = await startCreateIn(r, '/work/alpha', NEW_FILE);
    await waitFor(() => expect(document.activeElement).toBe(first));
    act(() => {
      fireEvent.change(first, { target: { value: 'draft' } });
    });
    // 命令面板「资源管理器: 新建文件夹…」/ 标题栏按钮同一入口
    act(() => requestExplorer({ kind: 'create', type: 'dir' }));
    await waitFor(() => expect(input()?.placeholder).toMatch(/新建文件夹名|New folder name/i));
    await waitFor(() => expect(document.activeElement).toBe(input()));
    expect(input()!.value).toBe('');
    // 输入即落在新输入条:Enter 新建的是文件夹
    submit(input()!, 'made');
    await waitFor(() => expect(coApi.fs.createDir).toHaveBeenCalledWith('/work/alpha', 'made'));
  });

  it('有名字时焦点移到别处 → 提交新建;焦点留在用户点的地方', async () => {
    h.openFileByPath = vi.fn(async () => ({ ok: true as const }));
    h.editorFile = { openFileByPath: h.openFileByPath };
    const r = await mount();
    const el = await startCreateIn(r, '/work/alpha', NEW_FILE);
    await waitFor(() => expect(document.activeElement).toBe(el));
    act(() => {
      fireEvent.change(el, { target: { value: 'blurred.ts' } });
    });
    const other = outside();
    act(() => other.focus());
    await flush();
    await waitFor(() => expect(coApi.fs.createFile).toHaveBeenCalledWith('/work/alpha', 'blurred.ts'));
    await waitFor(() => expect(input()).toBeNull());
    other.remove();
  });

  it('空名时焦点移到别处 → 放弃新建(不创建),焦点不被拉回树', async () => {
    const r = await mount();
    const el = await startCreateIn(r, '/work/alpha', NEW_FILE);
    await waitFor(() => expect(document.activeElement).toBe(el));
    const other = outside();
    act(() => other.focus());
    await flush();
    await waitFor(() => expect(input()).toBeNull());
    await act(async () => {
      await new Promise((res) => setTimeout(res, 50));
    });
    expect(document.activeElement).toBe(other);
    expect(coApi.fs.createFile).not.toHaveBeenCalled();
    other.remove();
  });

  it('失焦提交尚未完成时又开了新的新建 → 新输入条不被那次提交关掉', async () => {
    let release!: () => void;
    vi.mocked(coApi.fs.createFile).mockImplementationOnce(
      (dir: string, name: string) =>
        new Promise((res) => {
          release = () => res(createIn(dir, name, false) as never);
        }) as never,
    );
    const r = await mount();
    const el = await startCreateIn(r, '/work/alpha', NEW_FILE);
    await waitFor(() => expect(document.activeElement).toBe(el));
    act(() => {
      fireEvent.change(el, { target: { value: 'pending.ts' } });
    });
    const other = outside();
    act(() => other.focus());
    await flush();
    await waitFor(() => expect(coApi.fs.createFile).toHaveBeenCalledWith('/work/alpha', 'pending.ts'));
    other.remove();
    act(() => requestExplorer({ kind: 'create', type: 'dir' }));
    await waitFor(() => expect(input()?.placeholder).toMatch(/新建文件夹名|New folder name/i));
    await act(async () => {
      release();
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(input()).not.toBeNull();
    expect(input()!.placeholder).toMatch(/新建文件夹名|New folder name/i);
  });
});
