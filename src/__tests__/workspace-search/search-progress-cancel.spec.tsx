// @vitest-environment jsdom
// BDD: workspace-search / 7 搜索进行中的反馈与取消(VSCode searchView withProgress delay 300 + search.action.cancel),
// 无结果时的排除项提示与入口(VSCode SearchView.onSearchComplete:noResultsFound / noResultsIncludes… + 打开设置 /
// 在所有文件中重新搜索 / 重新搜索)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SearchEvent, SearchFileResult, SearchQuery } from '../../../electron/shared/workspace-search';

const h = vi.hoisted(() => ({
  start: vi.fn(async (_id: string, _q: unknown) => ({ ok: true })),
  cancel: vi.fn(async (_id: string) => ({ ok: true })),
  listener: null as ((e: unknown) => void) | null,
  openSettings: vi.fn(),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    search: {
      start: h.start,
      cancel: h.cancel,
      onEvent: (cb: (e: unknown) => void) => {
        h.listener = cb;
        return () => {
          h.listener = null;
        };
      },
    },
  },
}));
vi.mock('@/plugins/co-app', () => ({ coApp: { settingItems: new Map() }, openFileInEditor: vi.fn() }));
vi.mock('@/lib/toggle-settings-panel', () => ({ openSettingsPanel: h.openSettings }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 22,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 22, size: 22 })),
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
}));

import { setLocale, t } from '@/i18n';
import { notifyLocaleChange } from '@/i18n/react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useSettingsStore } from '@/plugins/settings/store';
import { SEARCH_PROGRESS_DELAY_MS, SearchPanel } from '@/panels/Search/SearchPanel';
import { __resetSearchForTest, SEARCH_DEBOUNCE_MS, useSearchStore } from '@/panels/Search/search-store';

beforeEach(() => {
  vi.useFakeTimers();
  setLocale('zh');
  useWorkspaceStore.setState({ root: '/w' });
});
afterEach(() => {
  cleanup();
  __resetSearchForTest();
  vi.clearAllMocks();
  vi.useRealTimers();
  setLocale('en');
  useWorkspaceStore.setState({ root: null });
});

const files: SearchFileResult[] = [
  {
    path: '/w/a.ts',
    relPath: 'a.ts',
    matches: [{ line: 1, column: 1, length: 3, preview: 'foo', previewStart: 0, previewLength: 3 }],
  },
];
const emit = (e: SearchEvent) => act(() => h.listener!(e));
const status = () => screen.getByRole('status').textContent;
const progress = () => screen.queryByRole('progressbar');
const cancelButton = () => screen.queryByRole('button', { name: '取消搜索' });
const tree = () => screen.getByRole('tree');

function startSearch(pattern = 'foo'): string {
  render(<SearchPanel />);
  fireEvent.change(screen.getByRole('textbox', { name: '搜索' }), { target: { value: pattern } });
  act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
  return (h.start.mock.calls.at(-1) as [string, SearchQuery])[0];
}

describe('搜索进行中:延迟出现的细进度条 + 取消搜索', () => {
  it('搜索期间结果树 aria-busy;进度条与「取消搜索」按钮 300ms 后才出现(快的搜索不闪),完成后立即消失', () => {
    const id = startSearch();
    expect(tree().getAttribute('aria-busy')).toBe('true');
    expect(progress()).toBeNull();
    expect(cancelButton()).toBeNull();
    act(() => vi.advanceTimersByTime(SEARCH_PROGRESS_DELAY_MS - 1));
    expect(progress()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(progress()).not.toBeNull();
    expect(progress()!.getAttribute('aria-label')).toBe(t('panels.search.searching'));
    expect(cancelButton()).not.toBeNull();

    // 第一批结果到了仍在搜索:进度条与按钮还在(此前与「已完成」看起来一样)
    emit({ searchId: id, kind: 'files', files });
    expect(progress()).not.toBeNull();
    expect(tree().getAttribute('aria-busy')).toBe('true');

    emit({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false });
    expect(progress()).toBeNull();
    expect(cancelButton()).toBeNull();
    expect(tree().hasAttribute('aria-busy')).toBe(false);
  });

  it('点「取消搜索」→ 取消在途查询,保留已到的结果,状态行写明已取消;迟到的事件丢弃', () => {
    const id = startSearch();
    emit({ searchId: id, kind: 'files', files });
    act(() => vi.advanceTimersByTime(SEARCH_PROGRESS_DELAY_MS));
    fireEvent.click(cancelButton()!);
    expect(h.cancel).toHaveBeenCalledWith(id);
    expect(useSearchStore.getState().status).toBe('cancelled');
    expect(status()).toBe('1 个文件中有 1 个结果。搜索已取消');
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
    expect(progress()).toBeNull();
    expect(cancelButton()).toBeNull();
    emit({ searchId: id, kind: 'files', files: [{ ...files[0]!, path: '/w/b.ts', relPath: 'b.ts' }] });
    emit({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false });
    expect(useSearchStore.getState().status).toBe('cancelled');
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
  });

  it('取消时还没有结果 →「搜索在找到任何结果前已取消」+「重新搜索」', () => {
    startSearch();
    act(() => vi.advanceTimersByTime(SEARCH_PROGRESS_DELAY_MS));
    fireEvent.click(cancelButton()!);
    expect(status()).toBe('搜索在找到任何结果前已取消');
    h.start.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '重新搜索' }));
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(useSearchStore.getState().status).toBe('searching');
  });

  it('焦点在结果树时 Esc 取消在途搜索(VSCode search.action.cancel);不在搜索时 Esc 不被吞', () => {
    const id = startSearch();
    emit({ searchId: id, kind: 'files', files });
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      tree().dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(h.cancel).toHaveBeenCalledWith(id);
    expect(useSearchStore.getState().status).toBe('cancelled');

    const again = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      tree().dispatchEvent(again);
    });
    expect(again.defaultPrevented).toBe(false);
  });
});

describe('无结果时提示排除设置与忽略文件', () => {
  it('使用排除设置与忽略文件(默认开)→ 追加提示 +「打开设置」(切到搜索设置所在页签并打开设置)', () => {
    const id = startSearch('zzz');
    emit({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false });
    expect(status()).toBe('未找到结果。查看设置中配置的排除项并检查 gitignore 文件');
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
    expect(useSettingsStore.getState().activeTabId).toBe('core.explorer');
    expect(h.openSettings).toHaveBeenCalledTimes(1);
  });

  it('关掉「使用排除设置与忽略文件」→ 不提示(已不受它们影响)', () => {
    const id = startSearch('zzz');
    act(() => useSearchStore.getState().toggleUseExcludesAndIgnoreFiles());
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    const next = h.start.mock.calls.at(-1)![0];
    expect(next).not.toBe(id);
    emit({ searchId: next, kind: 'done', limitHit: false, filesLimitHit: false });
    expect(status()).toBe('未找到结果');
    expect(screen.queryByRole('button', { name: '打开设置' })).toBeNull();
  });

  it('有包含 / 排除条件 → 写明条件 +「在所有文件中重新搜索」(清空包含 / 排除后重搜)', () => {
    render(<SearchPanel />);
    act(() => {
      useSearchStore.getState().setInclude('src/**');
      useSearchStore.getState().setExclude('*.md');
      useSearchStore.getState().setPattern('zzz');
    });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    let id = h.start.mock.calls.at(-1)![0];
    emit({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false });
    expect(status()).toBe('在「src/**」中未找到结果（已排除「*.md」）');
    fireEvent.click(screen.getByRole('button', { name: '在所有文件中重新搜索' }));
    const q = h.start.mock.calls.at(-1)![1] as SearchQuery;
    expect(q.include).toBe('');
    expect(q.exclude).toBe('');
    id = h.start.mock.calls.at(-1)![0];
    expect(useSearchStore.getState().include).toBe('');

    act(() => useSearchStore.getState().setInclude('lib'));
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    id = h.start.mock.calls.at(-1)![0];
    emit({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false });
    expect(status()).toBe('在「lib」中未找到结果');
    act(() => useSearchStore.setState({ include: '', exclude: 'dist' }));
    expect(status()).toBe('未找到结果（已排除「dist」）');
  });

  it('三语', () => {
    const id = startSearch('zzz');
    emit({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false });
    act(() => {
      setLocale('en');
      notifyLocaleChange();
    });
    expect(status()).toBe('No results found. Review your settings for configured exclusions and check your gitignore files');
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeTruthy();
    expect(t('panels.search.no_results_hint')).toBe('Review your settings for configured exclusions and check your gitignore files');
    expect(t('panels.search.open_settings')).toBe('Open Settings');
    expect(t('panels.search.cancel')).toBe('Cancel Search');
    setLocale('ko');
    expect(t('panels.search.open_settings')).toBe('설정 열기');
    expect(t('panels.search.cancel')).toBe('검색 취소');
    expect(t('panels.search.no_results_in', { include: 'x' })).toBe("'x'에서 결과 없음");
  });
});
