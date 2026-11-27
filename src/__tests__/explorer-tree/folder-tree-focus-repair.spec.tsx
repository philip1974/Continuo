// @vitest-environment jsdom
// 焦点项不再显示(「折叠全部」/ 外部删除)→ 焦点修正到仍显示的行(最近的显示中祖先,否则原下标附近),Tab 仍能进树;
// DOM 焦点原在被移除的行上时同时移过去(不掉到 body,↓ 照常);DOM 焦点在树外时不抢。
// VSCode 列表容器本身可 Tab 进入(listView domNode.tabIndex=0)、焦点为空时 ↓ 从首项起;这里是 roving tabIndex,须有一行 tabIndex=0。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const h = vi.hoisted(() => ({
  dirListeners: [] as ((path: string, files?: string[], changeOnly?: boolean) => void)[],
}));

const ROOT_ENTRIES: FileEntry[] = [
  { path: '/work/alpha', name: 'alpha', isDirectory: true },
  { path: '/work/beta.ts', name: 'beta.ts', isDirectory: false },
  { path: '/work/bravo.ts', name: 'bravo.ts', isDirectory: false },
  { path: '/work/charlie.ts', name: 'charlie.ts', isDirectory: false },
];
const fsTree = new Map<string, FileEntry[]>();

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: fsTree.get(p) ?? [] })),
      move: vi.fn(),
      copy: vi.fn(),
      trash: vi.fn(),
      reveal: vi.fn(),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn((cb: (path: string) => void) => {
        h.dirListeners.push(cb);
        return () => {
          h.dirListeners = h.dirListeners.filter((x) => x !== cb);
        };
      }),
      onWatchLost: vi.fn(() => vi.fn()),
      onRootPresenceChanged: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 22,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, start: i * 22, size: 22, key: i })),
    scrollToIndex: () => {},
  }),
}));
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: async () => ({ ok: true }) }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({
  ExplorerHeader: ({ onCollapseAll }: { onCollapseAll?: () => void }) => (
    <button type="button" onClick={onCollapseAll}>
      collapse-all
    </button>
  ),
}));

import { useEditorStore } from '../../stores/editor.store';
import { FolderTree } from '../../panels/Explorer/FolderTree';

const row = (container: HTMLElement, p: string) =>
  container.querySelector(`[title="${p}"]`) as HTMLElement | null;
const tabStops = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="treeitem"][tabindex="0"]')].map((el) => el.getAttribute('title'));

beforeEach(() => {
  fsTree.clear();
  fsTree.set('/work', ROOT_ENTRIES);
  fsTree.set('/work/alpha', [
    { path: '/work/alpha/a1.ts', name: 'a1.ts', isDirectory: false },
    { path: '/work/alpha/b.ts', name: 'b.ts', isDirectory: false },
  ]);
  h.dirListeners = [];
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useEditorStore.setState({ activeTabId: null });
});
afterEach(() => cleanup());

async function mount(expanded: string[] = []) {
  useExplorerStore.setState({ expandedPaths: new Set(expanded) });
  const r = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row(r.container, '/work/charlie.ts')).not.toBeNull());
  return r;
}

/** 单击某行并给它 DOM 焦点(真实浏览器 mousedown 聚焦可聚焦行;jsdom 的 click 不会)。 */
async function clickRow(container: HTMLElement, p: string) {
  act(() => {
    fireEvent.click(row(container, p)!);
    row(container, p)!.focus();
  });
  await waitFor(() => expect(document.activeElement).toBe(row(container, p)));
}

/** 磁盘上删掉 path,并派发它所在目录的 fs 变化(同 main 的 watcher 广播)。 */
function externalDelete(dir: string, path: string) {
  fsTree.set(dir, (fsTree.get(dir) ?? []).filter((e) => e.path !== path));
  act(() => {
    for (const cb of h.dirListeners) cb(dir, undefined, false);
  });
}

describe('FolderTree · 折叠后焦点项被隐藏', () => {
  it('焦点在 alpha/b.ts 上「折叠全部」→ 焦点移到最近的显示中祖先 alpha(唯一 tabIndex=0),↓ 从它继续', async () => {
    const { container } = await mount(['/work/alpha']);
    await waitFor(() => expect(row(container, '/work/alpha/b.ts')).not.toBeNull());
    await clickRow(container, '/work/alpha/b.ts');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'collapse-all' }));
    });
    await waitFor(() => expect(row(container, '/work/alpha/b.ts')).toBeNull());
    expect(tabStops(container)).toEqual(['/work/alpha']);
  });
});

describe('FolderTree · 外部删除焦点行', () => {
  it('根下的焦点行被删 → 焦点与 DOM 焦点移到原下标处的行(下一行),不掉到 body;↓ 照常', async () => {
    const { container } = await mount();
    await clickRow(container, '/work/bravo.ts');
    externalDelete('/work', '/work/bravo.ts');
    await waitFor(() => expect(row(container, '/work/bravo.ts')).toBeNull());
    expect(tabStops(container)).toEqual(['/work/charlie.ts']);
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/charlie.ts')));
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', code: 'ArrowUp' });
    });
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/beta.ts')));
  });

  it('末行被删 → 移到新的末行', async () => {
    const { container } = await mount();
    await clickRow(container, '/work/charlie.ts');
    externalDelete('/work', '/work/charlie.ts');
    await waitFor(() => expect(row(container, '/work/charlie.ts')).toBeNull());
    expect(tabStops(container)).toEqual(['/work/bravo.ts']);
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/bravo.ts')));
  });

  it('展开目录里的焦点行被删 → 移到其父目录行', async () => {
    const { container } = await mount(['/work/alpha']);
    await waitFor(() => expect(row(container, '/work/alpha/b.ts')).not.toBeNull());
    await clickRow(container, '/work/alpha/b.ts');
    externalDelete('/work/alpha', '/work/alpha/b.ts');
    await waitFor(() => expect(row(container, '/work/alpha/b.ts')).toBeNull());
    expect(tabStops(container)).toEqual(['/work/alpha']);
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/alpha')));
  });

  it('DOM 焦点已在树外(如编辑器)→ 只修正树焦点项(tabIndex),不把 DOM 焦点拉回树', async () => {
    const { container } = await mount();
    await clickRow(container, '/work/bravo.ts');
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    try {
      act(() => outside.focus());
      externalDelete('/work', '/work/bravo.ts');
      await waitFor(() => expect(row(container, '/work/bravo.ts')).toBeNull());
      expect(tabStops(container)).toEqual(['/work/charlie.ts']);
      await new Promise((r) => setTimeout(r, 50));
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});
