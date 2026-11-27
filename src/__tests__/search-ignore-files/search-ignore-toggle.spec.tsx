// @vitest-environment jsdom
// BDD: search-ignore-files —— 搜索视图「使用排除设置与忽略文件」开关与设置 search.useIgnoreFiles 组装进查询;开关随搜索输入持久化
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SearchQuery } from '../../../electron/shared/workspace-search';

const h = vi.hoisted(() => ({ start: vi.fn(async (_id: string, _q: unknown) => ({ ok: true })) }));
vi.mock('@/lib/co-api', () => ({
  coApi: { search: { start: h.start, cancel: vi.fn(async () => ({ ok: true })), onEvent: () => () => {} } },
}));
vi.mock('@/plugins/co-app', () => ({ coApp: { editor: { openFile: vi.fn() }, settingItems: new Map() }, openFileInEditor: vi.fn() }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({ getTotalSize: () => 0, getVirtualItems: () => [], scrollToIndex: () => {}, measureElement: () => {} }),
}));

import { setLocale } from '@/i18n';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { SearchPanel } from '@/panels/Search/SearchPanel';
import { __resetSearchForTest, restoreSearchInput, searchInputSnapshot, SEARCH_DEBOUNCE_MS, useSearchStore } from '@/panels/Search/search-store';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import { ExplorerSchemaV3 } from '../../../electron/shared/explorer-persistence-schema';

beforeEach(() => {
  vi.useFakeTimers();
  setLocale('zh');
  useWorkspaceStore.setState({ root: '/w' });
});
afterEach(() => {
  cleanup();
  __resetSearchForTest();
  useSettingsValuesStore.getState().reset('search.useIgnoreFiles');
  vi.clearAllMocks();
  vi.useRealTimers();
  setLocale('en');
  useWorkspaceStore.setState({ root: null });
});

const lastQuery = () => h.start.mock.calls.at(-1)![1] as SearchQuery;
function search(pattern: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '搜索' }), { target: { value: pattern } });
  act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
}

describe('「使用排除设置与忽略文件」开关', () => {
  it('在排除框旁,默认开;默认查询不带 disregard*(遵从忽略文件与排除表)', () => {
    render(<SearchPanel />);
    fireEvent.click(screen.getByRole('button', { name: '切换搜索详细信息' }));
    const toggle = screen.getByRole('button', { name: '使用「排除设置」与「忽略文件」' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    search('needle');
    expect(lastQuery()).not.toHaveProperty('disregardIgnoreFiles');
    expect(lastQuery()).not.toHaveProperty('disregardExcludeSettings');
  });

  it('关掉 → 立即重搜,不用忽略文件也不用排除设置', () => {
    render(<SearchPanel />);
    search('needle');
    fireEvent.click(screen.getByRole('button', { name: '切换搜索详细信息' }));
    const before = h.start.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '使用「排除设置」与「忽略文件」' }));
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(h.start.mock.calls.length).toBe(before + 1);
    expect(lastQuery()).toMatchObject({ disregardIgnoreFiles: true, disregardExcludeSettings: true });
    expect(screen.getByRole('button', { name: '使用「排除设置」与「忽略文件」' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('设置 search.useIgnoreFiles 关 → 只是不用忽略文件', () => {
    useSettingsValuesStore.getState().setValue('search.useIgnoreFiles', false);
    render(<SearchPanel />);
    search('needle');
    expect(lastQuery().disregardIgnoreFiles).toBe(true);
    expect(lastQuery()).not.toHaveProperty('disregardExcludeSettings');
  });

  it('关闭状态随搜索输入持久化(只写关),恢复后保持', () => {
    useSearchStore.getState().toggleUseExcludesAndIgnoreFiles();
    const snap = searchInputSnapshot();
    expect(snap).toEqual({ pattern: '', useExcludesAndIgnoreFiles: false });
    expect(ExplorerSchemaV3.shape.windows.element.shape.search.unwrap().safeParse(snap).success).toBe(true);
    __resetSearchForTest();
    expect(useSearchStore.getState().useExcludesAndIgnoreFiles).toBe(true);
    restoreSearchInput(snap!);
    expect(useSearchStore.getState().useExcludesAndIgnoreFiles).toBe(false);
    restoreSearchInput({ pattern: 'x' });
    expect(useSearchStore.getState().useExcludesAndIgnoreFiles).toBe(true);
  });
});
