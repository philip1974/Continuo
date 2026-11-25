// @vitest-environment jsdom
// BDD: workspace-search / 5 视图:去抖搜索、取消旧查询、分组结果树、计数文案三语、非法正则提示、包含 / 排除、键盘导航与打开、F4
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SearchEvent, SearchFileResult, SearchQuery } from '../../../electron/shared/workspace-search';

const h = vi.hoisted(() => ({
  start: vi.fn(async (_id: string, _q: unknown) => ({ ok: true })),
  cancel: vi.fn(async (_id: string) => ({ ok: true })),
  listener: null as ((e: unknown) => void) | null,
  openFile: vi.fn(async (_p: string, _o?: unknown) => ({ ok: true, lineApplied: true })),
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
vi.mock('@/plugins/co-app', () => ({ coApp: { editor: { openFile: h.openFile } } }));
// jsdom 无布局:虚拟列表全量渲染
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
import {
  __resetSearchForTest,
  focusNextSearchResult,
  SEARCH_DEBOUNCE_MS,
  useSearchStore,
} from '@/panels/Search/search-store';

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

const queryBox = () => screen.getByRole('textbox', { name: '搜索' });
function type(value: string) {
  fireEvent.change(queryBox(), { target: { value } });
}
const flush = () => act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
const lastStart = () => {
  const call = h.start.mock.calls.at(-1)!;
  return { id: call[0], query: call[1] as SearchQuery };
};
const emit = (e: SearchEvent) => act(() => h.listener!(e));
const match = (line: number, column: number, preview: string, start: number, length: number) => ({
  line,
  column,
  length,
  preview,
  previewStart: start,
  previewLength: length,
});
const files: SearchFileResult[] = [
  { path: '/w/src/a.ts', relPath: 'src/a.ts', matches: [match(1, 7, 'const foo = 1', 6, 3), match(4, 1, 'foo()', 0, 3)] },
  { path: '/w/b.md', relPath: 'b.md', matches: [match(2, 3, '# foo', 2, 3)] },
];

describe('去抖与取消', () => {
  it('输入后 300ms 才搜索;连续输入只搜最后一次;查询带三个开关与包含 / 排除', () => {
    render(<SearchPanel />);
    type('f');
    type('fo');
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1));
    expect(h.start).not.toHaveBeenCalled();
    type('foo');
    flush();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(lastStart().query).toEqual({ pattern: 'foo', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '' });
  });

  it('Enter 立即搜索;新查询先取消在途查询;迟到的旧事件丢弃', () => {
    render(<SearchPanel />);
    type('foo');
    fireEvent.keyDown(queryBox(), { key: 'Enter' });
    const first = lastStart().id;
    type('bar');
    flush();
    expect(h.cancel).toHaveBeenCalledWith(first);
    emit({ searchId: first, kind: 'files', files });
    expect(screen.queryByRole('treeitem')).toBeNull();
  });

  it('清空查询 → 取消并清空结果', () => {
    render(<SearchPanel />);
    type('foo');
    flush();
    const { id } = lastStart();
    emit({ searchId: id, kind: 'files', files });
    type('');
    flush();
    expect(h.cancel).toHaveBeenCalledWith(id);
    expect(screen.queryByRole('treeitem')).toBeNull();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('未打开工作区 → 提示先打开文件夹,不发起搜索', () => {
    useWorkspaceStore.setState({ root: null });
    render(<SearchPanel />);
    type('foo');
    flush();
    expect(h.start).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('请先在资源管理器中打开工作区');
  });
});

describe('选项与非法正则', () => {
  it('三个开关 aria-pressed 成组,切换后重新搜索', () => {
    render(<SearchPanel />);
    type('foo');
    flush();
    const group = screen.getByRole('group', { name: '搜索选项' });
    const regex = within(group).getByRole('button', { name: '使用正则表达式' });
    expect(regex.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(regex);
    fireEvent.click(within(group).getByRole('button', { name: '区分大小写' }));
    fireEvent.click(within(group).getByRole('button', { name: '全词匹配' }));
    flush();
    expect(regex.getAttribute('aria-pressed')).toBe('true');
    expect(lastStart().query).toMatchObject({ isRegex: true, matchCase: true, wholeWord: true });
  });

  it('正则模式下非法正则:不搜索,输入框 aria-invalid,提示「正则表达式无效」', () => {
    render(<SearchPanel />);
    fireEvent.click(screen.getByRole('button', { name: '使用正则表达式' }));
    type('a(');
    flush();
    expect(h.start).not.toHaveBeenCalled();
    expect(queryBox().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('正则表达式无效');
  });

  it('「切换搜索详细信息」展开包含 / 排除输入,输入后带入查询', () => {
    render(<SearchPanel />);
    const toggle = screen.getByRole('button', { name: '切换搜索详细信息' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('textbox', { name: '包含的文件' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    type('foo');
    fireEvent.change(screen.getByRole('textbox', { name: '包含的文件' }), { target: { value: 'src' } });
    fireEvent.change(screen.getByRole('textbox', { name: '排除的文件' }), { target: { value: '*.md' } });
    flush();
    expect(lastStart().query).toMatchObject({ include: 'src', exclude: '*.md' });
  });
});

describe('结果树与计数', () => {
  function withResults(done: Partial<Extract<SearchEvent, { kind: 'done' }>> = {}) {
    render(<SearchPanel />);
    type('foo');
    flush();
    const { id } = lastStart();
    expect(screen.getByRole('status').textContent).toBe('正在搜索…');
    emit({ searchId: id, kind: 'files', files });
    emit({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false, ...done });
    return id;
  }

  it('按文件分组:文件行(文件名 + 相对目录 + 匹配数)与匹配行(命中 <mark> 高亮);计数三语', () => {
    withResults();
    const tree = screen.getByRole('tree', { name: '搜索结果' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '2', '1', '2']);
    expect(items[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(items[0]!.textContent).toContain('a.ts');
    expect(items[0]!.textContent).toContain('src');
    expect(items[0]!.textContent).toContain('2');
    const mark = items[1]!.querySelector('mark')!;
    expect(mark.textContent).toBe('foo');
    expect(mark.className).toContain('text-list-highlight');
    expect(screen.getByRole('status').textContent).toBe('2 个文件中有 3 个结果');
    act(() => {
      setLocale('en');
      notifyLocaleChange();
    });
    expect(screen.getByRole('status').textContent).toBe('3 results in 2 files');
    act(() => {
      setLocale('ko');
      notifyLocaleChange();
    });
    expect(screen.getByRole('status').textContent).toBe('파일 2개에서 결과 3개');
  });

  it('文件行超长文件名:文件名与目录都可收缩截断(目录先收缩),匹配数徽标不收缩、始终可见', () => {
    withResults();
    const row = within(screen.getByRole('tree')).getAllByRole('treeitem')[0]!;
    const [, name, dir, badge] = Array.from(row.children) as HTMLElement[];
    expect(name!.textContent).toBe('a.ts');
    expect(name!.className).toMatch(/\bmin-w-0\b/);
    expect(name!.className).toMatch(/\btruncate\b/);
    expect(name!.className).not.toMatch(/\bshrink-0\b/);
    expect(dir!.textContent).toBe('src');
    expect(dir!.className).toMatch(/\bmin-w-0\b/);
    expect(dir!.className).toMatch(/\btruncate\b/);
    // 目录的收缩权重远大于文件名:空间不够时目录先缩到 0,文件名再截断
    expect(dir!.className).toMatch(/\bshrink-\[\d{3,}\]/);
    expect(badge!.className).toMatch(/\bshrink-0\b/);
  });

  it('无结果 / 截断 / 文件数上限 / 失败提示', () => {
    render(<SearchPanel />);
    type('zzz');
    flush();
    let { id } = lastStart();
    emit({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false });
    expect(screen.getByRole('status').textContent).toBe('未找到结果');
    type('foo');
    flush();
    ({ id } = lastStart());
    emit({ searchId: id, kind: 'files', files });
    emit({ searchId: id, kind: 'done', limitHit: true, filesLimitHit: true });
    expect(screen.getByRole('status').textContent).toContain('2 个文件中有 3 个结果');
    expect(screen.getByRole('status').textContent).toContain('结果过多');
    expect(screen.getByRole('status').textContent).toContain('文件过多');
    type('err');
    flush();
    ({ id } = lastStart());
    emit({ searchId: id, kind: 'error', code: 'FS_DIR_TOO_LARGE', message: 'x' });
    expect(screen.getByRole('status').textContent).toBe('搜索失败：目录条目过多');
  });

  it('键盘:↓ 从查询框进入结果树;↑↓ 移动;← 折叠 / → 展开;Enter 打开并定位行列、选中匹配(length)', async () => {
    withResults();
    const tree = screen.getByRole('tree');
    fireEvent.keyDown(queryBox(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tree);
    const active = () => document.getElementById(tree.getAttribute('aria-activedescendant')!)!;
    expect(active().getAttribute('aria-level')).toBe('1');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(active().getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      fireEvent.keyDown(tree, { key: 'Enter' });
    });
    expect(h.openFile).toHaveBeenCalledWith('/w/src/a.ts', { line: 1, column: 7, length: 3 });
    fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // 匹配行 ← 回到文件行
    expect(active().getAttribute('aria-level')).toBe('1');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // 文件行 ← 折叠
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(3);
    expect(active().getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(5);
    fireEvent.keyDown(tree, { key: 'End' });
    expect(active().textContent).toContain('# foo');
  });

  it('单击匹配行打开;单击文件行切换折叠', async () => {
    withResults();
    const items = screen.getAllByRole('treeitem');
    await act(async () => {
      fireEvent.click(items[4]!);
    });
    expect(h.openFile).toHaveBeenCalledWith('/w/b.md', { line: 2, column: 3, length: 3 });
    fireEvent.click(items[0]!);
    expect(screen.getAllByRole('treeitem')).toHaveLength(3);
  });

  it('F4(下一个结果):依次打开各匹配,到末尾回到第一个', async () => {
    withResults();
    for (const expected of [
      ['/w/src/a.ts', { line: 1, column: 7, length: 3 }],
      ['/w/src/a.ts', { line: 4, column: 1, length: 3 }],
      ['/w/b.md', { line: 2, column: 3, length: 3 }],
      ['/w/src/a.ts', { line: 1, column: 7, length: 3 }],
    ]) {
      await act(async () => focusNextSearchResult(1));
      expect(h.openFile).toHaveBeenLastCalledWith(...expected);
    }
    await act(async () => focusNextSearchResult(-1));
    expect(h.openFile).toHaveBeenLastCalledWith('/w/b.md', { line: 2, column: 3, length: 3 });
  });

  it('请求聚焦(⇧⌘F):焦点进查询框并全选;带入的选区文本替换查询', () => {
    render(<SearchPanel />);
    type('old');
    act(() => useSearchStore.getState().requestFocus('picked'));
    expect(document.activeElement).toBe(queryBox());
    expect((queryBox() as HTMLInputElement).value).toBe('picked');
    flush();
    expect(lastStart().query.pattern).toBe('picked');
  });
});
