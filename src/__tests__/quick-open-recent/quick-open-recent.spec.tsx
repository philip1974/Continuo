// @vitest-environment jsdom
// Quick Open「最近打开」(VSCode:空查询先列编辑器历史,按工作区跨重启保留)。见同目录 README.md。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('../../plugins/quick-open/walk-files', () => ({ walkWorkspaceFiles: vi.fn() }));
// jsdom 无布局:virtualizer 渲染全部行(同 quick-open-modal 用例)
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import {
  MAX_RECENT_FILES,
  MAX_RECENT_FILE_ROOTS,
  RECENT_FILES_STORAGE_KEY,
  recentFilesFor,
  recordRecentFile,
} from '../../plugins/quick-open/recent-files';
import { QuickOpenModal } from '../../plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore, type QuickOpenFile } from '../../plugins/quick-open/store';
import { walkWorkspaceFiles } from '../../plugins/quick-open/walk-files';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { t } from '../../i18n';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const walkMock = walkWorkspaceFiles as unknown as ReturnType<typeof vi.fn>;

function file(relPath: string): QuickOpenFile {
  return {
    name: relPath.split('/').pop()!,
    relPath,
    relPathLower: relPath.toLowerCase(),
    absPath: `/proj/${relPath}`,
  };
}

async function openModal(files: QuickOpenFile[]) {
  walkMock.mockResolvedValue({ ok: true, data: files });
  useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
  useQuickOpenStore.setState({ isOpen: true });
  render(<QuickOpenModal />);
  await waitFor(() => expect(document.querySelectorAll('[role=option]').length).toBe(files.length));
}

const rows = () => Array.from(document.querySelectorAll('[role=option]'));
const rowNames = () => rows().map((r) => r.querySelector('span')!.textContent);

beforeEach(() => {
  localStorage.clear();
  walkMock.mockReset();
  useQuickOpenStore.setState({ isOpen: false, query: '', selectedIndex: 0, results: [], resultsRoot: null, loading: false, scanFailed: false });
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});
afterEach(() => cleanup());

describe('记录:按工作区记最近打开的文件', () => {
  it('最近的在前、重复项移到最前;按工作区根分开', () => {
    recordRecentFile('/proj', '/proj/a.ts');
    recordRecentFile('/proj', '/proj/b.ts');
    recordRecentFile('/proj', '/proj/a.ts');
    recordRecentFile('/other', '/other/x.ts');
    expect(recentFilesFor('/proj')).toEqual(['/proj/a.ts', '/proj/b.ts']);
    expect(recentFilesFor('/other')).toEqual(['/other/x.ts']);
  });

  it(`每个工作区至多 ${MAX_RECENT_FILES} 条,至多记 ${MAX_RECENT_FILE_ROOTS} 个工作区(最久未用的先淘汰)`, () => {
    for (let i = 0; i < MAX_RECENT_FILES + 5; i++) recordRecentFile('/proj', `/proj/${i}.ts`);
    const list = recentFilesFor('/proj');
    expect(list).toHaveLength(MAX_RECENT_FILES);
    expect(list[0]).toBe(`/proj/${MAX_RECENT_FILES + 4}.ts`);
    for (let i = 0; i < MAX_RECENT_FILE_ROOTS; i++) recordRecentFile(`/r${i}`, `/r${i}/f`);
    expect(recentFilesFor('/proj')).toEqual([]);
    expect(recentFilesFor(`/r${MAX_RECENT_FILE_ROOTS - 1}`)).toEqual([`/r${MAX_RECENT_FILE_ROOTS - 1}/f`]);
  });

  it('跨重启:写进 localStorage,读回即得', () => {
    recordRecentFile('/proj', '/proj/a.ts');
    expect(localStorage.getItem(RECENT_FILES_STORAGE_KEY)).toContain('/proj/a.ts');
  });

  it('localStorage 畸形 / 不可用 → 当空列表,不抛', () => {
    localStorage.setItem(RECENT_FILES_STORAGE_KEY, '{not json');
    expect(recentFilesFor('/proj')).toEqual([]);
    localStorage.setItem(RECENT_FILES_STORAGE_KEY, JSON.stringify([{ root: '/proj', paths: [1, '/proj/ok.ts'] }, 'x']));
    expect(recentFilesFor('/proj')).toEqual(['/proj/ok.ts']);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => recordRecentFile('/proj', '/proj/b.ts')).not.toThrow();
    spy.mockRestore();
  });

  it('用户打开 / 切换到文件即记录;会话恢复(不请求焦点)不记录;工作区外的文件不记录', () => {
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    const ed = useEditorStore.getState();
    ed.openTab(createTab('/proj/restored.ts', ''), { requestFocus: false });
    ed.openTab(createTab('/proj/a.ts', ''));
    ed.openTab(createTab('/proj/b.ts', ''));
    ed.switchTab('/proj/a.ts');
    ed.openTab(createTab('/elsewhere/x.ts', ''));
    expect(recentFilesFor('/proj')).toEqual(['/proj/a.ts', '/proj/b.ts']);
  });
});

describe('改名 / 移动 / 删除后最近记录跟随(VSCode HistoryService.moveInHistory)', () => {
  it('文件改名 / 移动 → 旧路径原位改写为新路径(顺序不变)', () => {
    recordRecentFile('/proj', '/proj/c.ts');
    recordRecentFile('/proj', '/proj/file-3.ts');
    recordRecentFile('/proj', '/proj/a.ts');
    useEditorStore.getState().renamePath('/proj/file-3.ts', '/proj/sub/file-3.ts');
    expect(recentFilesFor('/proj')).toEqual(['/proj/a.ts', '/proj/sub/file-3.ts', '/proj/c.ts']);
  });

  it('目录改名 → 其下全部最近文件同前缀改写;同前缀的兄弟目录不受影响', () => {
    recordRecentFile('/proj', '/proj/src/x.ts');
    recordRecentFile('/proj', '/proj/srcx/y.ts');
    recordRecentFile('/proj', '/proj/src/deep/z.ts');
    useEditorStore.getState().renamePath('/proj/src', '/proj/lib');
    expect(recentFilesFor('/proj')).toEqual(['/proj/lib/deep/z.ts', '/proj/srcx/y.ts', '/proj/lib/x.ts']);
  });

  it('改名(含撤销改名)后打开着的 tab 仍在「最近打开」里,无需再激活一次', async () => {
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useEditorStore.getState().openTab(createTab('/proj/b.ts', ''));
    useEditorStore.getState().renamePath('/proj/b.ts', '/proj/renamed.ts');
    useEditorStore.getState().renamePath('/proj/renamed.ts', '/proj/b2.ts');
    await openModal([file('a.ts'), file('b2.ts')]);
    expect(rowNames()).toEqual(['b2.ts', 'a.ts']);
    expect(rows()[0]!.textContent).toContain(t('quick_open.recently_opened'));
  });

  it('移到已在列表里的路径 → 去重,保留靠前的一条', () => {
    recordRecentFile('/proj', '/proj/old.ts');
    recordRecentFile('/proj', '/proj/new.ts');
    useEditorStore.getState().renamePath('/proj/old.ts', '/proj/new.ts');
    expect(recentFilesFor('/proj')).toEqual(['/proj/new.ts']);
  });

  it('删除文件 / 目录 → 从最近记录移除', () => {
    recordRecentFile('/proj', '/proj/d/a.ts');
    recordRecentFile('/proj', '/proj/b.ts');
    recordRecentFile('/proj', '/proj/c.ts');
    useEditorStore.getState().removePaths(['/proj/d', '/proj/c.ts']);
    expect(recentFilesFor('/proj')).toEqual(['/proj/b.ts']);
  });
});

describe('Quick Open 列表', () => {
  it('空查询:最近打开的排最前(按最近顺序)并标「最近打开」,其后为其余文件', async () => {
    recordRecentFile('/proj', '/proj/src/c.ts');
    recordRecentFile('/proj', '/proj/b.ts');
    await openModal([file('a.ts'), file('b.ts'), file('src/c.ts'), file('d.ts')]);
    expect(rowNames()).toEqual(['b.ts', 'c.ts', 'a.ts', 'd.ts']);
    const label = t('quick_open.recently_opened');
    expect(rows()[0]!.textContent).toContain(label);
    expect(rows()[1]!.textContent).not.toContain(label);
    expect(rows()[2]!.textContent).not.toContain(label);
    // 其余文件与最近项之间有分隔
    expect(rows()[2]!.className).toContain('border-t');
  });

  it('已删除(不在扫描结果里)的最近文件不显示', async () => {
    recordRecentFile('/proj', '/proj/gone.ts');
    recordRecentFile('/proj', '/proj/b.ts');
    await openModal([file('a.ts'), file('b.ts')]);
    expect(rowNames()).toEqual(['b.ts', 'a.ts']);
  });

  it('无最近记录 → 原顺序,无「最近打开」标签', async () => {
    await openModal([file('a.ts'), file('b.ts')]);
    expect(rowNames()).toEqual(['a.ts', 'b.ts']);
    expect(document.body.textContent).not.toContain(t('quick_open.recently_opened'));
  });

  it('有查询:按匹配度排序,同分时最近打开的优先;不显示「最近打开」标签', async () => {
    recordRecentFile('/proj', '/proj/y/util.ts');
    await openModal([file('x/util.ts'), file('y/util.ts')]);
    act(() => {
      fireEvent.change(document.querySelector('.wm-modal-content input')!, { target: { value: 'util' } });
    });
    expect(rows().map((r) => r.getAttribute('title'))).toEqual(['y/util.ts', 'x/util.ts']);
    expect(document.body.textContent).not.toContain(t('quick_open.recently_opened'));
  });

  it('「最近打开」三语齐全', () => {
    for (const cat of [en, zh, ko]) expect(cat['quick_open.recently_opened']).toBeTruthy();
  });
});
