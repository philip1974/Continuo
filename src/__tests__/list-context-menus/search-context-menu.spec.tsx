// @vitest-environment jsdom
// BDD:搜索结果右键菜单(VSCode MenuId.SearchContext)。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SearchFileResult, SearchQuery } from '../../../electron/shared/workspace-search';

const h = vi.hoisted(() => ({
  start: vi.fn(async (_id: string, _q: unknown) => ({ ok: true })),
  cancel: vi.fn(async (_id: string) => ({ ok: true })),
  writeText: vi.fn(async (_text: string) => {}),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: { search: { start: h.start, cancel: h.cancel, onEvent: () => () => {} } },
}));
vi.mock('@/plugins/sandbox-sweep', () => ({ getCachedClipboard: () => ({ writeText: h.writeText }) }));
vi.mock('@/plugins/co-app', () => ({ coApp: { settingItems: new Map() }, openFileInEditor: vi.fn() }));
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
import { useWorkspaceStore } from '@/stores/workspace.store';
import { SearchPanel } from '@/panels/Search/SearchPanel';
import { __resetSearchForTest, useSearchStore } from '@/panels/Search/search-store';

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
  { path: '/w/b.test.md', relPath: 'b.test.md', matches: [match(2, 3, '# foo', 2, 3)] },
];

const items = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]'));
const labelOf = (el: HTMLElement): string => el.querySelector('.wm-menu-item__content')?.textContent ?? '';
const labels = (): string[] => items().map(labelOf);
const choose = (label: string) => fireEvent.click(items().find((el) => labelOf(el) === label)!);
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
// 菜单打开期间 Radix 给菜单外的节点加 aria-hidden(模态),查询带 hidden
const tree = () => screen.getByRole('tree', { hidden: true });
const rowsOf = () => within(tree()).getAllByRole('treeitem', { hidden: true });
const row = (name: RegExp) => within(tree()).getByRole('treeitem', { name, hidden: true });

function showResults() {
  useSearchStore.setState({ pattern: 'foo', status: 'done', files, resultCount: 3 });
  render(<SearchPanel />);
}

beforeEach(() => {
  setLocale('en');
  useWorkspaceStore.setState({ root: '/w' });
});
afterEach(() => {
  cleanup();
  __resetSearchForTest();
  vi.clearAllMocks();
  useWorkspaceStore.setState({ root: null });
});

describe('菜单项(VSCode 同组同序)', () => {
  it('文件行:移除 / 排除 · 包含此文件类型 ─ 复制 / 复制路径 / 全部复制;右键的行成为活动行', () => {
    showResults();
    fireEvent.contextMenu(row(/^b\.test\.md/));
    expect(labels()).toEqual([
      'Dismiss',
      'Exclude File Type from Search',
      'Include File Type in Search',
      'Copy',
      'Copy Path',
      'Copy All',
    ]);
    expect(document.querySelectorAll('[role=menu] [role=separator]')).toHaveLength(1);
    expect(row(/^b\.test\.md/).getAttribute('aria-selected')).toBe('true');
  });

  it('匹配行:移除 ─ 复制 / 全部复制(无复制路径、无文件类型项)', () => {
    showResults();
    fireEvent.contextMenu(row(/^Line 4, column 1/));
    expect(labels()).toEqual(['Dismiss', 'Copy', 'Copy All']);
    expect(row(/^Line 4, column 1/).getAttribute('aria-selected')).toBe('true');
  });

  it('三语文案', () => {
    setLocale('zh');
    showResults();
    fireEvent.contextMenu(row(/^src\/a\.ts/));
    expect(labels()).toEqual(['移除', '从搜索中排除此文件类型', '在搜索中包含此文件类型', '复制', '复制路径', '全部复制']);
    cleanup();
    setLocale('ko');
    render(<SearchPanel />);
    fireEvent.contextMenu(row(/^src\/a\.ts/));
    expect(labels()).toEqual(['해제', '검색에서 이 파일 형식 제외', '검색에 이 파일 형식 포함', '복사', '경로 복사', '모두 복사']);
  });

  it('无结果:右键不弹菜单', () => {
    render(<SearchPanel />);
    fireEvent.contextMenu(tree());
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('复制(VSCode searchActionsCopy 格式)', () => {
  it('匹配行「复制」= `行,列: 预览`', async () => {
    showResults();
    fireEvent.contextMenu(row(/^Line 1, column 7/));
    choose('Copy');
    await settle();
    expect(h.writeText).toHaveBeenCalledWith('1,7: const foo = 1');
  });

  it('文件行「复制」= 绝对路径 + 各匹配(缩进 2);「复制路径」= 绝对路径', async () => {
    showResults();
    fireEvent.contextMenu(row(/^src\/a\.ts/));
    choose('Copy');
    fireEvent.contextMenu(row(/^src\/a\.ts/));
    choose('Copy Path');
    await settle();
    expect(h.writeText.mock.calls.map((c) => c[0])).toEqual(['/w/src/a.ts\n  1,7: const foo = 1\n  4,1: foo()', '/w/src/a.ts']);
  });

  it('「全部复制」= 各文件以空行分隔', async () => {
    showResults();
    fireEvent.contextMenu(row(/^Line 4, column 1/));
    choose('Copy All');
    await settle();
    expect(h.writeText).toHaveBeenCalledWith(
      '/w/src/a.ts\n  1,7: const foo = 1\n  4,1: foo()\n\n/w/b.test.md\n  2,3: # foo',
    );
  });
});

describe('移除(Dismiss)', () => {
  it('匹配行:只移除该匹配,计数更新,活动行移到原位置的下一行', () => {
    showResults();
    fireEvent.contextMenu(row(/^Line 1, column 7/));
    choose('Dismiss');
    expect(rowsOf().map((r) => r.getAttribute('aria-label'))).toEqual([
      'src/a.ts: 1 result',
      'Line 4, column 1: foo()',
      'b.test.md: 1 result',
      'Line 2, column 3: # foo',
    ]);
    expect(useSearchStore.getState().resultCount).toBe(2);
    expect(screen.getByRole('status').textContent).toBe('2 results in 2 files');
    expect(row(/^Line 4, column 1/).getAttribute('aria-selected')).toBe('true');
  });

  it('文件行:移除该文件全部结果;文件最后一个匹配被移除时连文件一起移除', () => {
    showResults();
    fireEvent.contextMenu(row(/^src\/a\.ts/));
    choose('Dismiss');
    expect(rowsOf().map((r) => r.getAttribute('aria-label'))).toEqual(['b.test.md: 1 result', 'Line 2, column 3: # foo']);
    expect(useSearchStore.getState().resultCount).toBe(1);
    fireEvent.contextMenu(row(/^Line 2, column 3/));
    choose('Dismiss');
    expect(within(tree()).queryAllByRole('treeitem', { hidden: true })).toHaveLength(0);
    expect(useSearchStore.getState().resultCount).toBe(0);
  });
});

describe('排除 / 包含文件类型(VSCode modifySearchFileTypePattern)', () => {
  it('追加 `*.扩展名` 到排除框、展开详情并立即重搜;已有则不重复', () => {
    showResults();
    fireEvent.contextMenu(row(/^b\.test\.md/));
    choose('Exclude File Type from Search');
    expect(useSearchStore.getState().exclude).toBe('*.test.md');
    expect(useSearchStore.getState().detailsOpen).toBe(true);
    expect((h.start.mock.calls.at(-1)![1] as SearchQuery).exclude).toBe('*.test.md');
    const calls = h.start.mock.calls.length;
    act(() => useSearchStore.setState({ status: 'done', files, resultCount: 3 }));
    fireEvent.contextMenu(row(/^b\.test\.md/));
    choose('Exclude File Type from Search');
    expect(h.start.mock.calls.length).toBe(calls);
  });

  it('包含:已有其它 glob → 以「, 」追加', () => {
    useSearchStore.setState({ include: 'src/**' });
    showResults();
    fireEvent.contextMenu(row(/^src\/a\.ts/));
    choose('Include File Type in Search');
    expect(useSearchStore.getState().include).toBe('src/**, *.ts');
    expect((h.start.mock.calls.at(-1)![1] as SearchQuery).include).toBe('src/**, *.ts');
  });
});

describe('键盘', () => {
  it('树聚焦时 Shift+F10 在活动行处打开菜单;Esc 关闭后焦点回到结果树', async () => {
    showResults();
    tree().focus();
    fireEvent.keyDown(tree(), { key: 'ArrowDown' });
    fireEvent.keyDown(tree(), { key: 'ArrowDown' }); // 活动行 = 第一个匹配
    fireEvent.keyDown(tree(), { key: 'F10', shiftKey: true });
    expect(labels()).toEqual(['Dismiss', 'Copy', 'Copy All']);
    fireEvent.keyDown(items()[0]!, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(tree());
  });

  it('菜单键同样打开', () => {
    showResults();
    act(() => tree().focus()); // 聚焦 → 活动行 = 第一行
    fireEvent.keyDown(tree(), { key: 'ContextMenu' });
    expect(labels()).toEqual([
      'Dismiss',
      'Exclude File Type from Search',
      'Include File Type in Search',
      'Copy',
      'Copy Path',
      'Copy All',
    ]);
  });
});
