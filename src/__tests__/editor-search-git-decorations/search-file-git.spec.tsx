// @vitest-environment jsdom
// BDD: editor-search-git-decorations / 搜索结果文件行:文件名颜色 + 字母、悬浮提示带状态、可访问名称不变、设置开关、无结果不查询
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SearchEvent, SearchFileResult } from '../../../electron/shared/workspace-search';
import type { GitStatusSnapshot } from '../../../electron/shared/git-status';

const h = vi.hoisted(() => ({
  start: vi.fn(async (_id: string, _q: unknown) => ({ ok: true })),
  cancel: vi.fn(async (_id: string) => ({ ok: true })),
  listener: null as ((e: unknown) => void) | null,
  status: vi.fn(),
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
    git: { status: h.status },
    fs: { onDirChanged: () => () => {} },
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
import { useWorkspaceStore } from '@/stores/workspace.store';
import { SearchPanel } from '@/panels/Search/SearchPanel';
import { __resetSearchForTest, SEARCH_DEBOUNCE_MS } from '@/panels/Search/search-store';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import { SEARCH_DECORATIONS_BADGES, SEARCH_DECORATIONS_COLORS } from '@/plugins/settings/core-setting-specs';

const ENTRIES: GitStatusSnapshot['entries'] = [['src/a.ts', 'modified', 'M']];
const match = (line: number, preview: string) => ({
  line,
  column: 1,
  length: 3,
  preview,
  previewStart: 0,
  previewLength: 3,
});
const FILES: SearchFileResult[] = [
  { path: '/w/src/a.ts', relPath: 'src/a.ts', matches: [match(1, 'foo')] },
  { path: '/w/b.md', relPath: 'b.md', matches: [match(2, 'foo')] },
];
const flushAsync = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  vi.useFakeTimers();
  setLocale('zh');
  useWorkspaceStore.setState({ root: '/w' });
  useSettingsValuesStore.setState({ values: {} });
  h.status.mockReset();
  h.status.mockResolvedValue({ ok: true, data: { root: '/w', entries: ENTRIES } });
});
afterEach(() => {
  cleanup();
  __resetSearchForTest();
  vi.useRealTimers();
  setLocale('en');
  useWorkspaceStore.setState({ root: null });
});

async function search(files: SearchFileResult[] = FILES) {
  render(<SearchPanel />);
  fireEvent.change(screen.getByRole('textbox', { name: '搜索' }), { target: { value: 'foo' } });
  act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
  const id = h.start.mock.calls.at(-1)![0];
  act(() => h.listener!({ searchId: id, kind: 'files', files } satisfies SearchEvent));
  act(() => h.listener!({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false } satisfies SearchEvent));
  await flushAsync();
}
const fileRow = (rel: string) =>
  screen.getAllByRole('treeitem').find((el) => el.getAttribute('aria-level') === '1' && el.getAttribute('title')?.startsWith(rel))!;
const nameOf = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-git-title]');
const letterOf = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-git-letter]');

describe('结果文件行按 git 状态装饰', () => {
  it('文件名着色 + 字母(aria-hidden);无状态的文件不装饰', async () => {
    await search();
    const a = fileRow('src/a.ts');
    expect(nameOf(a)?.className).toContain('text-git-modified');
    expect(nameOf(a)?.textContent).toBe('a.ts');
    expect(letterOf(a)?.textContent).toBe('M');
    expect(letterOf(a)?.getAttribute('aria-hidden')).toBe('true');
    const b = fileRow('b.md');
    expect(nameOf(b)?.className ?? '').not.toContain('text-git-');
    expect(letterOf(b)).toBeNull();
  });

  it('悬浮提示追加状态;可访问名称不含状态(VSCode fileMatchAriaLabel)', async () => {
    await search();
    const a = fileRow('src/a.ts');
    expect(a.getAttribute('title')).toBe('src/a.ts · 已修改');
    expect(a.getAttribute('aria-label')).not.toContain('已修改');
  });

  it('默认值按 VSCode(search.decorations.colors / badges 都 true)', () => {
    expect(SEARCH_DECORATIONS_COLORS.default).toBe(true);
    expect(SEARCH_DECORATIONS_BADGES.default).toBe(true);
  });

  it('colors=false → 不着色、字母仍在;badges=false → 无字母、颜色仍在', async () => {
    await search();
    act(() => useSettingsValuesStore.setState({ values: { [SEARCH_DECORATIONS_COLORS.id]: false } }));
    expect(nameOf(fileRow('src/a.ts'))?.className ?? '').not.toContain('text-git-');
    expect(letterOf(fileRow('src/a.ts'))?.textContent).toBe('M');
    act(() => useSettingsValuesStore.setState({ values: { [SEARCH_DECORATIONS_BADGES.id]: false } }));
    expect(nameOf(fileRow('src/a.ts'))?.className).toContain('text-git-modified');
    expect(letterOf(fileRow('src/a.ts'))).toBeNull();
  });

  it('两项都关 → 不查询;无结果 → 不查询', async () => {
    useSettingsValuesStore.setState({
      values: { [SEARCH_DECORATIONS_COLORS.id]: false, [SEARCH_DECORATIONS_BADGES.id]: false },
    });
    await search();
    expect(h.status).not.toHaveBeenCalled();
    cleanup();
    __resetSearchForTest();
    useSettingsValuesStore.setState({ values: {} });
    await search([]);
    expect(h.status).not.toHaveBeenCalled();
  });
});
