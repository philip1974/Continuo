// @vitest-environment jsdom
// BDD: workspace-scan-unreadable / 在文件中查找:done 事件带跳过的目录数 → 状态行追加「已跳过 N 个无法读取的目录」(三语)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { isSearchEvent, type SearchEvent } from '../../../electron/shared/workspace-search';

const h = vi.hoisted(() => ({
  start: vi.fn(async (_id: string, _q: unknown) => ({ ok: true })),
  cancel: vi.fn(async (_id: string) => ({ ok: true })),
  listener: null as ((e: unknown) => void) | null,
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
vi.mock('@/plugins/co-app', () => ({ coApp: { editor: { openFile: vi.fn() }, settingItems: new Map() }, openFileInEditor: vi.fn() }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 22,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 22, size: 22 })),
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
}));

import { setLocale } from '@/i18n';
import { notifyLocaleChange } from '@/i18n/react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { SearchPanel } from '@/panels/Search/SearchPanel';
import { __resetSearchForTest, SEARCH_DEBOUNCE_MS } from '@/panels/Search/search-store';

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

function searchAndFinish(done: Partial<Extract<SearchEvent, { kind: 'done' }>>): void {
  render(<SearchPanel />);
  fireEvent.change(screen.getByRole('textbox', { name: '搜索' }), { target: { value: 'foo' } });
  act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
  const id = h.start.mock.calls.at(-1)![0];
  act(() =>
    h.listener!({
      searchId: id,
      kind: 'files',
      files: [{ path: '/w/a.ts', relPath: 'a.ts', matches: [{ line: 1, column: 1, length: 3, preview: 'foo', previewStart: 0, previewLength: 3 }] }],
    }),
  );
  act(() => h.listener!({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false, ...done }));
}

describe('跳过的目录提示', () => {
  it('skippedUnreadableDirs > 0 → 结果照常,状态行追加提示;三语', () => {
    searchAndFinish({ skippedUnreadableDirs: 2 });
    expect(screen.getByRole('status').textContent).toBe('1 个文件中有 1 个结果。已跳过 2 个无法读取的目录');
    act(() => {
      setLocale('en');
      notifyLocaleChange();
    });
    expect(screen.getByRole('status').textContent).toContain('Skipped 2 folders that could not be read');
    act(() => {
      setLocale('ko');
      notifyLocaleChange();
    });
    expect(screen.getByRole('status').textContent).toContain('읽을 수 없는 폴더 2개를 건너뛰었습니다');
  });

  it('没有跳过(缺省 / 0)→ 不追加提示', () => {
    searchAndFinish({ skippedUnreadableDirs: 0 });
    expect(screen.getByRole('status').textContent).not.toContain('无法读取');
  });

  it('preload 形态守卫:skippedUnreadableDirs 须为非负整数', () => {
    const done = { searchId: 's', kind: 'done', limitHit: false, filesLimitHit: false };
    expect(isSearchEvent({ ...done, skippedUnreadableDirs: 3 })).toBe(true);
    expect(isSearchEvent({ ...done, skippedUnreadableDirs: -1 })).toBe(false);
    expect(isSearchEvent({ ...done, skippedUnreadableDirs: 1.5 })).toBe(false);
  });
});
