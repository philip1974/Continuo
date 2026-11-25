// @vitest-environment jsdom
// BDD: workspace-search / 7 已打开编辑器的内存内容(VSCode getLocalResults):未保存修改可搜、超 1 MiB 的打开文件可搜、结果覆盖磁盘
// 同一文件、规则 / 上限与 main 同口径;未打开的大文件提示「已跳过 N 个」;无结果时范围提示照样显示。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_RESULTS,
  type SearchEvent,
  type SearchFileResult,
} from '../../../electron/shared/workspace-search';

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
vi.mock('@/plugins/co-app', () => ({ coApp: { editor: { openFile: vi.fn(async () => ({ ok: true })) } } }));
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
import { createTab, useEditorStore, type EditorTab } from '@/stores/editor.store';
import { SearchPanel } from '@/panels/Search/SearchPanel';
import { __resetSearchForTest, SEARCH_DEBOUNCE_MS, useSearchStore } from '@/panels/Search/search-store';
import { mergeDiskBatch } from '@/panels/Search/open-editor-search';

const initialEditor = useEditorStore.getState();
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
  useEditorStore.setState(initialEditor, true);
});

/** 已打开的文档:disk = 磁盘内容,content = 编辑器当前内容(不同即脏)。 */
function openDoc(filePath: string, disk: string, content = disk): EditorTab {
  const tab = createTab(filePath, disk);
  return content === disk ? tab : { ...tab, content, dirty: true };
}
function setTabs(...tabs: EditorTab[]): void {
  useEditorStore.setState({ tabs, activeTabId: tabs[0]?.id ?? null });
}
function search(pattern: string): string {
  render(<SearchPanel />);
  fireEvent.change(screen.getByRole('textbox', { name: '搜索' }), { target: { value: pattern } });
  act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
  return h.start.mock.calls.at(-1)![0];
}
const emit = (e: SearchEvent) => act(() => h.listener!(e));
const diskMatch = (line: number, column: number, preview: string) => ({
  line,
  column,
  length: 3,
  preview,
  previewStart: column - 1,
  previewLength: 3,
});
const fileRows = () => screen.queryAllByRole('treeitem').filter((el) => el.getAttribute('aria-level') === '1');
const matchRows = () => screen.queryAllByRole('treeitem').filter((el) => el.getAttribute('aria-level') === '2');

describe('已打开编辑器在内存内容上搜索', () => {
  it('未保存的修改可搜:结果在 main 推送前就显示;main 推来的同一文件(磁盘旧内容)结果被丢弃', () => {
    setTabs(openDoc('/w/src/a.ts', 'const bar = 1\n', 'const bar = 1\nlet foo = 2\n'));
    const id = search('foo');
    expect(matchRows().map((r) => r.textContent)).toEqual(['let foo = 2']);
    // 磁盘上 a.ts 没有 foo(main 不会推);即使推来同路径结果也被内存结果覆盖
    emit({ searchId: id, kind: 'files', files: [{ path: '/w/src/a.ts', relPath: 'src/a.ts', matches: [diskMatch(9, 1, 'foo-old')] }] });
    emit({ searchId: id, kind: 'files', files: [{ path: '/w/b.ts', relPath: 'b.ts', matches: [diskMatch(1, 1, 'foo()')] }] });
    emit({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false });
    expect(fileRows().map((r) => r.textContent)).toEqual([expect.stringContaining('a.ts'), expect.stringContaining('b.ts')]);
    expect(matchRows().map((r) => r.textContent)).toEqual(['let foo = 2', 'foo()']);
    expect(screen.getByRole('status').textContent).toBe('2 个文件中有 2 个结果');
  });

  it('未保存修改删掉了命中 → 磁盘上的旧命中不显示', () => {
    setTabs(openDoc('/w/a.ts', 'foo\n', 'bar\n'));
    const id = search('foo');
    emit({ searchId: id, kind: 'files', files: [{ path: '/w/a.ts', relPath: 'a.ts', matches: [diskMatch(1, 1, 'foo')] }] });
    emit({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false });
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toBe('未找到结果');
  });

  it('列号 UTF-16、正则 / 大小写 / 全词与 main 同口径', () => {
    setTabs(openDoc('/w/a.ts', '😀 Foo foo foobar\n'));
    search('foo');
    // 不区分大小写、字面量:3 处;列号按 UTF-16(😀 占 2)
    expect(useSearchStore.getState().files[0]!.matches.map((m) => m.column)).toEqual([4, 8, 12]);
    act(() => useSearchStore.getState().toggleOption('matchCase'));
    act(() => useSearchStore.getState().toggleOption('wholeWord'));
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(useSearchStore.getState().files[0]!.matches.map((m) => m.column)).toEqual([8]);
  });

  it('打开的大文件(> 1 MiB)在内存里搜到,且不计入「已跳过的大文件」;未打开的大文件提示已跳过', () => {
    const big = `${'x'.repeat(SEARCH_MAX_FILE_BYTES)}\nfoo here\n`;
    setTabs(openDoc('/w/big.log', big));
    const id = search('foo');
    expect(matchRows().map((r) => r.textContent)).toEqual(['foo here']);
    emit({
      searchId: id,
      kind: 'done',
      limitHit: false,
      filesLimitHit: false,
      skippedLargeCount: 2,
      skippedLargePaths: ['/w/big.log', '/w/data/huge.json'],
    });
    expect(screen.getByRole('status').textContent).toBe(
      '1 个文件中有 1 个结果。已跳过 1 个超过 1 MiB 的文件（在编辑器中打开后可搜索）',
    );
  });

  it('无结果时文件数上限 / 跳过大文件的提示照样显示(三语单复数)', () => {
    const id = search('foo');
    emit({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: true, skippedLargeCount: 2, skippedLargePaths: [] });
    expect(screen.getByRole('status').textContent).toBe(
      '未找到结果。文件过多，只搜索了前 50000 个文件。已跳过 2 个超过 1 MiB 的文件（在编辑器中打开后可搜索）',
    );
    act(() => {
      setLocale('en');
    });
    act(() => useSearchStore.setState({ skippedLarge: 1, filesLimitHit: false }));
    expect(screen.getByRole('status').textContent).toBe(
      'No results found. Skipped 1 file larger than 1 MiB (open it in the editor to search it)',
    );
  });

  it('工作区外、排除表目录(node_modules 等)、包含 / 排除 glob 不匹配、图片标签都不在内存里搜', () => {
    setTabs(
      openDoc('/other/a.ts', 'foo'),
      openDoc('/w/node_modules/p/a.ts', 'foo'),
      openDoc('/w/vendor/a.ts', 'foo'),
      openDoc('/w/pic.png', 'foo:123:4'),
      openDoc('/w/keep.ts', 'foo'),
    );
    act(() => useSearchStore.getState().setExclude('vendor'));
    search('foo');
    expect(useSearchStore.getState().files.map((f) => f.relPath)).toEqual(['keep.ts']);
  });

  it('总结果数上限与 main 一致:内存 + 磁盘合并后最多 SEARCH_MAX_RESULTS 条,超出标记 limitHit', () => {
    const many = (n: number, p: string): SearchFileResult => ({
      path: `/w/${p}`,
      relPath: p,
      matches: Array.from({ length: n }, (_, i) => diskMatch(i + 1, 1, 'foo')),
    });
    const merged = mergeDiskBatch([many(5, 'a.ts'), many(1000, 'b.ts'), many(1, 'c.ts')], new Set(['a.ts']), SEARCH_MAX_RESULTS - 10);
    expect(merged.files.map((f) => [f.relPath, f.matches.length])).toEqual([['b.ts', 10]]);
    expect(merged.added).toBe(10);
    expect(merged.limitHit).toBe(true);
    const ok = mergeDiskBatch([many(3, 'a.ts'), many(2, 'b.ts')], new Set(), 0);
    expect(ok).toMatchObject({ added: 5, limitHit: false });
  });
});
