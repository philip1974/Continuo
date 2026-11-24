// @vitest-environment jsdom
// Quick Open 选中文件 → 打开后焦点进入该文件的编辑器(VSCode:⌘P 回车后可直接打字)。见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('../../plugins/quick-open/walk-files', () => ({
  walkWorkspaceFiles: vi.fn(async () => ({ ok: true as const, data: [] })),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 28,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: () => {},
  }),
}));
const h = vi.hoisted(() => ({ result: { ok: true } as { ok: boolean; code?: string; message?: string } }));
vi.mock('@/panels/Editor/editor-file-actions', async () => {
  const { useEditorStore, createTab } = await import('../../stores/editor.store');
  return {
    openFileByPath: vi.fn(async (path: string) => {
      if (!h.result.ok) return h.result;
      useEditorStore.getState().openTab(createTab(path, ''));
      return { ok: true, data: undefined };
    }),
  };
});

import { QuickOpenModal } from '../../plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { registerEditorFocus } from '../../panels/Editor/editor-focus-registry';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
let unregister: (() => void) | null = null;

beforeEach(() => {
  h.result = { ok: true };
  useEditorStore.setState({ tabs: [], activeTabId: null });
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
  useQuickOpenStore.setState({
    isOpen: true,
    query: '',
    selectedIndex: 0,
    results: [{ name: 'a.ts', relPath: 'a.ts', relPathLower: 'a.ts', absPath: '/work/a.ts' }],
    resultsRoot: '/work',
    loading: false,
    scanFailed: false,
  });
});
afterEach(() => {
  unregister?.();
  unregister = null;
  cleanup();
});

describe('Quick Open 打开文件后焦点进编辑器', () => {
  it('回车打开 → 关闭弹窗,随后聚焦该文件的编辑器', async () => {
    const focus = vi.fn();
    unregister = registerEditorFocus('/work/a.ts', focus);
    const { getByRole } = render(<QuickOpenModal />);
    fireEvent.keyDown(getByRole('combobox'), { key: 'Enter' });
    await waitFor(() => expect(useQuickOpenStore.getState().isOpen).toBe(false));
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
  });

  it('打开失败 → 不请求聚焦', async () => {
    h.result = { ok: false, code: 'FS_ENOENT', message: 'gone' };
    const focus = vi.fn();
    unregister = registerEditorFocus('/work/a.ts', focus);
    useEditorStore.setState({ activeTabId: '/work/a.ts' });
    const { getByRole } = render(<QuickOpenModal />);
    fireEvent.keyDown(getByRole('combobox'), { key: 'Enter' });
    await waitFor(() => expect(useQuickOpenStore.getState().isOpen).toBe(false));
    await nextFrame();
    await nextFrame();
    expect(focus).not.toHaveBeenCalled();
  });
});
