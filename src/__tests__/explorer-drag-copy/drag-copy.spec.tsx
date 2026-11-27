// @vitest-environment jsdom
// BDD:资源管理器树内按住 ⌥(mac)/ Ctrl 拖放 = 复制(VSCode isCopy)。见同目录 README。
// 树用假 useTree(同 explorer-confirm-drag-and-drop):松手的修饰键由容器捕获阶段的 drop 记下,再调库的 onDrop 回调。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import type { TreeConfig } from '@headless-tree/core';
import type { FileEntry } from '../../lib/fs/types';

const h = vi.hoisted(() => ({
  useTree: vi.fn(),
  dnd: { current: null as { draggedItems: Array<{ getId: () => string; isFolder: () => boolean }> } | null },
  lastConfig: { current: null as TreeConfig<FileEntry> | null },
  listing: new Map<string, string[]>(),
  openDroppedFiles: vi.fn(async () => {}),
  platform: 'mac' as 'mac' | 'other',
}));

vi.mock('@headless-tree/react', () => ({ useTree: h.useTree }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({ getTotalSize: () => 0, getVirtualItems: () => [] }),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (dir: string) => ({
        ok: true,
        data: (h.listing.get(dir) ?? []).map((name) => ({ name, path: `${dir}/${name}`, isDirectory: false })),
      })),
      move: vi.fn(async () => ({ ok: true, data: undefined })),
      copy: vi.fn(async () => ({ ok: true, data: undefined })),
      trash: vi.fn(),
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
vi.mock('@/panels/Editor/useEditorFile', () => {
  const editorFile = { openFileByPath: async () => ({ ok: true }) };
  return { useEditorFile: () => editorFile };
});
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
  useSettingsValuesStore: { getState: () => ({ setValue: vi.fn() }) },
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));
vi.mock('@/shell/dock/explorer-editor-drop', async (orig) => ({
  ...(await orig<typeof import('@/shell/dock/explorer-editor-drop')>()),
  openDroppedFiles: h.openDroppedFiles,
}));
vi.mock('@/plugins/command-palette/format-hotkey', async (orig) => ({
  ...(await orig<typeof import('@/plugins/command-palette/format-hotkey')>()),
  detectPlatform: () => h.platform,
}));

import { FolderTree } from '../../panels/Explorer/FolderTree';
import { isCopyDragEvent } from '../../panels/Explorer/batch-transfer';
import { setLocale } from '../../i18n';
import { coApi } from '../../lib/co-api';

const move = coApi.fs.move as unknown as ReturnType<typeof vi.fn>;
const copy = coApi.fs.copy as unknown as ReturnType<typeof vi.fn>;

function fakeTree(config: TreeConfig<FileEntry>) {
  h.lastConfig.current = config;
  return {
    getItems: () => [],
    getState: () => ({ selectedItems: [], expandedItems: [], dnd: h.dnd.current }),
    getContainerProps: () => ({}),
    getItemInstance: () => ({ invalidateChildrenIds: vi.fn(), startRenaming: vi.fn() }),
    getConfig: () => config,
    getDataRef: () => ({ current: {} }),
    rebuildTree: vi.fn(),
    expandAll: vi.fn(),
    collapseAll: vi.fn(),
    updateDomFocus: vi.fn(),
  };
}

beforeEach(() => {
  setLocale('en');
  h.platform = 'mac';
  h.useTree.mockReset();
  h.useTree.mockImplementation(fakeTree);
  h.dnd.current = null;
  h.listing.clear();
  h.openDroppedFiles.mockClear();
  move.mockClear();
  copy.mockClear();
});
afterEach(() => cleanup());

const item = (id: string, folder = false) => ({ getId: () => id, isFolder: () => folder });
const folderTarget = (id: string) => ({ item: { isFolder: () => true, getId: () => id } });
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

/** jsdom 没有 DragEvent:拖放事件按普通 Event 派发,修饰键须另行挂到事件上。 */
function fireDrag(
  type: 'drop' | 'dragOver',
  el: Element,
  dataTransfer: object,
  mods: { altKey?: boolean; ctrlKey?: boolean } = {},
) {
  const ev = createEvent[type](el, { dataTransfer });
  Object.defineProperty(ev, 'altKey', { value: mods.altKey === true });
  Object.defineProperty(ev, 'ctrlKey', { value: mods.ctrlKey === true });
  fireEvent(el, ev);
}

/** 松手:容器捕获阶段先记下修饰键(同真实 drop 的事件顺序),再由库调 onDrop。 */
function dropOnto(
  container: HTMLElement,
  dragged: ReturnType<typeof item>[],
  dest: string,
  mods: { altKey?: boolean; ctrlKey?: boolean },
) {
  const onDrop = h.lastConfig.current!.onDrop as unknown as (i: unknown, t: unknown) => void;
  act(() => {
    fireDrag('drop', container.firstChild as Element, { types: [] }, mods);
    onDrop(dragged, folderTarget(dest));
  });
}

describe('isCopyDragEvent(平台判定,VSCode isCopy)', () => {
  it('mac:⌥ 是复制,Ctrl 不是;其它平台:Ctrl 是复制,Alt 不是', () => {
    expect(isCopyDragEvent({ altKey: true, ctrlKey: false }, 'mac')).toBe(true);
    expect(isCopyDragEvent({ altKey: false, ctrlKey: true }, 'mac')).toBe(false);
    expect(isCopyDragEvent({ altKey: false, ctrlKey: true }, 'other')).toBe(true);
    expect(isCopyDragEvent({ altKey: true, ctrlKey: false }, 'other')).toBe(false);
  });
});

describe('按住 ⌥ 拖到文件夹 → 复制', () => {
  it('不弹移动确认,直接复制;源不动;复制出的文件以常驻方式打开', async () => {
    const { container } = render(<FolderTree root="/repo" />);
    dropOnto(container, [item('/repo/a.txt')], '/repo/sub', { altKey: true });
    await flush();
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
    expect(move).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith('/repo/a.txt', '/repo/sub/a.txt');
    expect(h.openDroppedFiles).toHaveBeenCalledWith(['/repo/sub/a.txt'], undefined);
  });

  it('拖到原父目录 → 生成副本「a copy.txt」(移动时这是 no-op)', async () => {
    h.listing.set('/repo/sub', ['a.txt']);
    const { container } = render(<FolderTree root="/repo" />);
    dropOnto(container, [item('/repo/sub/a.txt')], '/repo/sub', { altKey: true });
    await flush();
    expect(copy).toHaveBeenCalledWith('/repo/sub/a.txt', '/repo/sub/a copy.txt');
  });

  it('目标已有同名 → 自动改名,不覆盖', async () => {
    h.listing.set('/repo/sub', ['a.txt']);
    const { container } = render(<FolderTree root="/repo" />);
    dropOnto(container, [item('/repo/a.txt')], '/repo/sub', { altKey: true });
    await flush();
    expect(copy).toHaveBeenCalledWith('/repo/a.txt', '/repo/sub/a copy.txt');
  });

  it('复制文件夹不打开编辑器(只打开复制出的文件)', async () => {
    const { container } = render(<FolderTree root="/repo" />);
    dropOnto(container, [item('/repo/lib', true), item('/repo/b.txt')], '/repo/sub', { altKey: true });
    await flush();
    expect(copy).toHaveBeenCalledWith('/repo/lib', '/repo/sub/lib');
    expect(copy).toHaveBeenCalledWith('/repo/b.txt', '/repo/sub/b.txt');
    expect(h.openDroppedFiles).toHaveBeenCalledWith(['/repo/sub/b.txt'], undefined);
  });

  it('不按修饰键 → 仍是移动(先确认)', async () => {
    const { container } = render(<FolderTree root="/repo" />);
    dropOnto(container, [item('/repo/a.txt')], '/repo/sub', {});
    expect(screen.getByRole('button', { name: 'Move' })).toBeTruthy();
    expect(copy).not.toHaveBeenCalled();
  });

  it('其它平台按 Ctrl 复制;mac 上按 Ctrl 不算复制', async () => {
    h.platform = 'other';
    const r1 = render(<FolderTree root="/repo" />);
    dropOnto(r1.container, [item('/repo/a.txt')], '/repo/sub', { ctrlKey: true });
    await flush();
    expect(copy).toHaveBeenCalledTimes(1);
    cleanup();
    copy.mockClear();
    h.platform = 'mac';
    const r2 = render(<FolderTree root="/repo" />);
    dropOnto(r2.container, [item('/repo/a.txt')], '/repo/sub', { ctrlKey: true });
    await flush();
    expect(copy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Move' })).toBeTruthy();
  });
});

describe('按住 ⌥ 拖到空白处(根)', () => {
  it('已在根下的也复制(生成副本),不弹确认', async () => {
    h.listing.set('/repo', ['a.txt']);
    const { container } = render(<FolderTree root="/repo" />);
    h.dnd.current = { draggedItems: [item('/repo/a.txt')] };
    fireDrag('drop', container.firstChild as Element, { types: [] }, { altKey: true });
    await flush();
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
    expect(copy).toHaveBeenCalledWith('/repo/a.txt', '/repo/a copy.txt');
  });
});

describe('拖动经过时的光标(dropEffect)', () => {
  it('树内拖动:按住 ⌥ → copy,否则 move', () => {
    const { container } = render(<FolderTree root="/repo" />);
    h.dnd.current = { draggedItems: [item('/repo/a.txt')] };
    const dt = { types: [] as string[], dropEffect: 'none' };
    fireDrag('dragOver', container.firstChild as Element, dt, { altKey: true });
    expect(dt.dropEffect).toBe('copy');
    fireDrag('dragOver', container.firstChild as Element, dt);
    expect(dt.dropEffect).toBe('move');
  });
});
