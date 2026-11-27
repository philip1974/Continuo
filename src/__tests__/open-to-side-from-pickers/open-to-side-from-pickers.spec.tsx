// @vitest-environment jsdom
// BDD: open-to-side-from-pickers —— Quick Open ⌘Enter / ⌥Enter 与搜索结果 ⌃Enter 打开到侧边组(侧边组由 takeSideEditorGroup 给出)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SearchQuery } from '../../../electron/shared/workspace-search';

const h = vi.hoisted(() => ({
  takeSide: vi.fn(() => 'editor:2' as string | undefined),
  openFileByPath: vi.fn(async (_p: string, _d: unknown, _o?: unknown) => ({ ok: true as const, data: undefined })),
  openFileInEditor: vi.fn(async (_p: string, _l?: unknown, _o?: unknown, _r?: unknown) => ({ ok: true, lineApplied: true })),
  start: vi.fn(async (_id: string, _q: unknown) => ({ ok: true })),
  listener: null as ((e: unknown) => void) | null,
}));

vi.mock('@/shell/dock/explorer-editor-drop', async (orig) => ({
  ...(await orig<typeof import('@/shell/dock/explorer-editor-drop')>()),
  takeSideEditorGroup: h.takeSide,
}));
vi.mock('@/panels/Editor/editor-file-actions', async (orig) => ({
  ...(await orig<typeof import('@/panels/Editor/editor-file-actions')>()),
  openFileByPath: h.openFileByPath,
}));
vi.mock('@/plugins/co-app', () => ({
  coApp: { editor: { openFile: h.openFileInEditor }, settingItems: new Map() },
  openFileInEditor: h.openFileInEditor,
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: { scanFiles: vi.fn() },
    search: {
      start: h.start,
      cancel: vi.fn(async () => ({ ok: true })),
      onEvent: (cb: (e: unknown) => void) => {
        h.listener = cb;
        return () => {
          h.listener = null;
        };
      },
    },
  },
}));
vi.mock('../../plugins/quick-open/walk-files', () => ({ walkWorkspaceFiles: vi.fn() }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
}));

import { setLocale } from '@/i18n';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { QuickOpenModal } from '@/plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { walkWorkspaceFiles } from '@/plugins/quick-open/walk-files';
import { SearchPanel } from '@/panels/Search/SearchPanel';
import { __resetSearchForTest, SEARCH_DEBOUNCE_MS } from '@/panels/Search/search-store';

const walkMock = walkWorkspaceFiles as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  setLocale('zh');
  useWorkspaceStore.setState({ root: '/proj' });
  useQuickOpenStore.setState({ isOpen: false, query: '', selectedIndex: 0, results: [], resultsRoot: null, loading: false });
  walkMock.mockResolvedValue({
    ok: true,
    data: [{ absPath: '/proj/src/a.ts', relPath: 'src/a.ts', relPathLower: 'src/a.ts', name: 'a.ts' }],
  });
});
afterEach(() => {
  cleanup();
  __resetSearchForTest();
  vi.clearAllMocks();
  vi.useRealTimers();
  setLocale('en');
  useWorkspaceStore.setState({ root: null });
});

async function quickOpen(query: string) {
  useQuickOpenStore.setState({ isOpen: true, query });
  render(<QuickOpenModal />);
  await waitFor(() => expect(document.querySelectorAll('ul li').length).toBe(1));
  return document.querySelector('.wm-modal-content input') as HTMLInputElement;
}

describe('Quick Open', () => {
  // jsdom 的平台判为非 mac:mod = Ctrl
  it.each([
    ['Ctrl+Enter(mac ⌘Enter)', { ctrlKey: true }],
    ['Alt+Enter(mac ⌥Enter)', { altKey: true }],
  ])('%s → 常驻打开到侧边组', async (_name, mods) => {
    const input = await quickOpen('a.ts');
    fireEvent.keyDown(input, { key: 'Enter', ...mods });
    await waitFor(() => expect(h.openFileByPath).toHaveBeenCalled());
    expect(h.takeSide).toHaveBeenCalledTimes(1);
    expect(h.openFileByPath.mock.calls[0]![0]).toBe('/proj/src/a.ts');
    expect(h.openFileByPath.mock.calls[0]![2]).toEqual({ preview: false, groupId: 'editor:2' });
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
  });

  it('Enter → 活动组(不取侧边组)', async () => {
    const input = await quickOpen('a.ts');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(h.openFileByPath).toHaveBeenCalled());
    expect(h.takeSide).not.toHaveBeenCalled();
    expect(h.openFileByPath.mock.calls[0]![2]).toEqual({ preview: false });
  });

  it('`文件:行` 在侧边打开同样跳到该行', async () => {
    const input = await quickOpen('a.ts:12');
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(h.openFileInEditor).toHaveBeenCalled());
    const [path, line, open] = h.openFileInEditor.mock.calls[0]!;
    expect(path).toBe('/proj/src/a.ts');
    expect(line).toEqual({ line: 12 });
    expect(open).toEqual({ preview: false, groupId: 'editor:2' });
  });
});

describe('搜索结果', () => {
  function withResult() {
    vi.useFakeTimers();
    useWorkspaceStore.setState({ root: '/w' });
    render(<SearchPanel />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索' }), { target: { value: 'foo' } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    const id = h.start.mock.calls.at(-1)![0];
    expect((h.start.mock.calls.at(-1)![1] as SearchQuery).pattern).toBe('foo');
    act(() =>
      h.listener!({
        searchId: id,
        kind: 'files',
        files: [
          {
            path: '/w/a.ts',
            relPath: 'a.ts',
            matches: [{ line: 3, column: 5, length: 3, preview: 'let foo', previewStart: 4, previewLength: 3 }],
          },
        ],
      }),
    );
    const tree = screen.getByRole('tree');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' }); // 文件行 → 匹配行
    return tree;
  }

  it('匹配行 Ctrl+Enter(mac ⌃Enter)→ 常驻打开到侧边组并定位命中', () => {
    const tree = withResult();
    fireEvent.keyDown(tree, { key: 'Enter', ctrlKey: true });
    expect(h.takeSide).toHaveBeenCalledTimes(1);
    expect(h.openFileInEditor).toHaveBeenCalledWith('/w/a.ts', { line: 3, column: 5, length: 3 }, { preview: false, groupId: 'editor:2' });
  });

  it('Enter → 活动组', () => {
    const tree = withResult();
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(h.takeSide).not.toHaveBeenCalled();
    expect(h.openFileInEditor).toHaveBeenCalledWith('/w/a.ts', { line: 3, column: 5, length: 3 }, { preview: false });
  });
});
