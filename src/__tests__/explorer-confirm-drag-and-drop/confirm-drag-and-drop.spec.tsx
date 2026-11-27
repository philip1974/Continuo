// @vitest-environment jsdom
// 误操作防护:树内拖动移动前确认(VSCode explorer.confirmDragAndDrop)+ 外部拖入同名的替换确认框接线。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TreeConfig } from '@headless-tree/core';
import type { FileEntry } from '../../lib/fs/types';
import type { ConfirmOverwrite } from '../../panels/Explorer/batch-transfer';

const h = vi.hoisted(() => ({
  useTree: vi.fn(),
  settings: new Map<string, unknown>(),
  setValue: vi.fn(),
  updateDomFocus: vi.fn(),
  dnd: { current: null as { draggedItems: Array<{ getId: () => string }> } | null },
  dropInto: vi.fn(async (..._args: unknown[]) => {}),
  lastConfig: { current: null as TreeConfig<FileEntry> | null },
}));

vi.mock('@headless-tree/react', () => ({ useTree: h.useTree }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({ getTotalSize: () => 0, getVirtualItems: () => [] }),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async () => ({ ok: true, data: [] })),
      move: vi.fn(async () => ({ ok: true, data: undefined })),
      copy: vi.fn(),
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
  useSettingValue: (key: string, fallback: unknown) =>
    h.settings.has(key) ? h.settings.get(key) : fallback,
  useSettingsValuesStore: { getState: () => ({ setValue: h.setValue }) },
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));
vi.mock('../../panels/Explorer/batch-transfer', async (orig) => ({
  ...(await orig<typeof import('../../panels/Explorer/batch-transfer')>()),
  dropForeignFilesInto: h.dropInto,
}));

import { FolderTree } from '../../panels/Explorer/FolderTree';
import { setLocale } from '../../i18n';
import { coApi } from '../../lib/co-api';
import {
  EXPLORER_CONFIRM_DRAG_AND_DROP,
} from '../../plugins/settings/core-setting-specs';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const move = coApi.fs.move as unknown as ReturnType<typeof vi.fn>;

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
    updateDomFocus: h.updateDomFocus,
  };
}

beforeEach(() => {
  setLocale('en');
  h.useTree.mockReset();
  h.useTree.mockImplementation(fakeTree);
  h.settings.clear();
  h.setValue.mockReset();
  h.updateDomFocus.mockReset();
  h.dropInto.mockClear();
  h.dnd.current = null;
  move.mockClear();
});
afterEach(() => cleanup());

const folder = (id: string) => ({ item: { isFolder: () => true, getId: () => id } });
const items = (...ids: string[]) => ids.map((id) => ({ getId: () => id }));

function dragOnto(ids: string[], dest: string) {
  const r = render(<FolderTree root="/repo" />);
  const onDrop = h.lastConfig.current!.onDrop as unknown as (i: unknown, t: unknown) => void;
  act(() => onDrop(items(...ids), folder(dest)));
  return r;
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

describe('设置 explorer.confirmDragAndDrop', () => {
  it('默认开,三语标题 / 说明齐全', () => {
    expect(EXPLORER_CONFIRM_DRAG_AND_DROP.id).toBe('explorer.confirmDragAndDrop');
    expect(EXPLORER_CONFIRM_DRAG_AND_DROP.default).toBe(true);
    expect(EXPLORER_CONFIRM_DRAG_AND_DROP.category).toBe('explorer');
    for (const loc of [en, zh, ko]) {
      expect(loc[EXPLORER_CONFIRM_DRAG_AND_DROP.titleKey as keyof typeof en]).toBeTruthy();
      expect(loc[EXPLORER_CONFIRM_DRAG_AND_DROP.descriptionKey as keyof typeof en]).toBeTruthy();
    }
  });
});

describe('树内拖动移动前确认', () => {
  it('拖到文件夹 → 先弹确认框、不移动;点「移动」才移动,焦点回树', async () => {
    dragOnto(['/repo/a.txt'], '/repo/sub');
    expect(screen.getByText('Are you sure you want to move “a.txt” into “sub”?')).toBeTruthy();
    expect(move).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await flush();
    expect(move).toHaveBeenCalledWith('/repo/a.txt', '/repo/sub/a.txt');
    expect(h.setValue).not.toHaveBeenCalled();
    expect(h.updateDomFocus).toHaveBeenCalled();
    expect(screen.queryByText(/Are you sure you want to move/)).toBeNull();
  });

  it('取消 → 不移动,焦点回树', async () => {
    dragOnto(['/repo/a.txt'], '/repo/sub');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(move).not.toHaveBeenCalled();
    expect(h.updateDomFocus).toHaveBeenCalled();
  });

  it('多项 → 标题带数量并列出名字', () => {
    dragOnto(['/repo/a.txt', '/repo/b.txt'], '/repo/sub');
    expect(
      screen.getByText('Are you sure you want to move the following 2 files/folders into “sub”?'),
    ).toBeTruthy();
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(screen.getByText('b.txt')).toBeTruthy();
  });

  it('勾「不再询问」再移动 → 设置写回 false', async () => {
    dragOnto(['/repo/a.txt'], '/repo/sub');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Do not ask me again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await flush();
    expect(h.setValue).toHaveBeenCalledWith('explorer.confirmDragAndDrop', false);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('设置关掉 → 直接移动,无确认框', async () => {
    h.settings.set('explorer.confirmDragAndDrop', false);
    dragOnto(['/repo/a.txt'], '/repo/sub');
    await flush();
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
    expect(move).toHaveBeenCalledWith('/repo/a.txt', '/repo/sub/a.txt');
  });

  it('拖到原父目录(no-op)→ 不弹框、不移动', async () => {
    dragOnto(['/repo/sub/a.txt'], '/repo/sub');
    await flush();
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
    expect(move).not.toHaveBeenCalled();
  });

  it('拖到空白(root)同样先确认', async () => {
    const { container } = render(<FolderTree root="/repo" />);
    h.dnd.current = { draggedItems: items('/repo/sub/a.txt') };
    fireEvent.drop(container.firstChild as Element, { dataTransfer: { types: [] } });
    expect(screen.getByText('Are you sure you want to move “a.txt” into “repo”?')).toBeTruthy();
    expect(move).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await flush();
    expect(move).toHaveBeenCalledWith('/repo/sub/a.txt', '/repo/a.txt');
  });
});

describe('外部拖入同名 → 替换确认框', () => {
  async function askOverwrite(names: string[], canSkip: boolean) {
    const { container } = render(<FolderTree root="/repo" />);
    await act(async () => {
      fireEvent.drop(container.firstChild as Element, {
        dataTransfer: { types: ['Files'], items: [] },
      });
    });
    expect(h.dropInto).toHaveBeenCalledTimes(1);
    const confirm = h.dropInto.mock.calls[0]![4] as ConfirmOverwrite;
    let answer: Promise<string>;
    act(() => {
      answer = confirm(names, canSkip);
    });
    return () => answer;
  }

  it('单个同名:标题点名、注明不可撤销;「替换」→ replace,焦点回树', async () => {
    const answer = await askOverwrite(['a.txt'], true);
    expect(
      screen.getByText(
        'A file with the name “a.txt” already exists in the destination folder. Do you want to replace it?',
      ),
    ).toBeTruthy();
    expect(screen.getByText('This action is irreversible!')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await expect(answer()).resolves.toBe('replace');
    expect(h.updateDomFocus).toHaveBeenCalled();
  });

  it('多个同名列出名字;「跳过同名文件」→ skip', async () => {
    const answer = await askOverwrite(['a.txt', 'b.txt'], true);
    expect(
      screen.getByText(
        'The following 2 files already exist in the destination folder. Do you want to replace them?',
      ),
    ).toBeTruthy();
    expect(screen.getByText('b.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Skip Existing' }));
    await expect(answer()).resolves.toBe('skip');
  });

  it('没有不冲突的项 → 不提供「跳过」;取消 → cancel', async () => {
    const answer = await askOverwrite(['a.txt'], false);
    expect(screen.queryByRole('button', { name: 'Skip Existing' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(answer()).resolves.toBe('cancel');
  });
});
