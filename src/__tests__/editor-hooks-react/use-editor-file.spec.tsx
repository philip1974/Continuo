// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { useEditorFile } from '../../panels/Editor/useEditorFile';
import { useEditorStore } from '../../stores/editor.store';
import { registerEditorWriteBack } from '../../panels/Editor/editor-writeback-registry';

function installFsApi(fs: Record<string, unknown>): void {
  Object.defineProperty(window, 'api', {
    value: { fs },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('useEditorFile', () => {
  it('saveActive 没 active tab → NO_ACTIVE_TAB', async () => {
    installFsApi({
      readFile: vi.fn(),
      writeFile: vi.fn(),
    });
    const { result } = renderHook(() => useEditorFile());
    const r = await result.current.saveActive();
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('NO_ACTIVE_TAB');
  });

  it('saveActive 先同步回写编辑器里未上抛的输入(Milkdown 200ms 防抖窗口内的最后几键也进入本次保存)', async () => {
    const writeFile = vi.fn(async () => ({ ok: true, data: undefined }));
    installFsApi({ readFile: vi.fn(async () => ({ ok: true, data: 'old' })), writeFile });
    useEditorStore.setState({
      tabs: [{ id: '/x.md', filePath: '/x.md', content: 'new', originalContent: 'old', dirty: true }],
      activeTabId: '/x.md',
    });
    const unregister = registerEditorWriteBack('/x.md', () => {
      useEditorStore.getState().updateContent('/x.md', 'newest');
    });
    try {
      const { result } = renderHook(() => useEditorFile());
      await result.current.saveActive();
      expect(writeFile).toHaveBeenCalledWith('/x.md', 'newest');
    } finally {
      unregister();
    }
  });

  it('saveActive 有 active tab → 调 writeFile + markSaved', async () => {
    const writeFile = vi.fn(async () => ({ ok: true, data: undefined }));
    installFsApi({
      // 保存前读盘比较:磁盘内容 = originalContent(未被外部修改)。
      readFile: vi.fn(async () => ({ ok: true, data: 'old' })),
      writeFile,
    });
    useEditorStore.setState({
      tabs: [
        {
          id: '/x.md',
          filePath: '/x.md',
          content: 'new',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/x.md',
    });

    const { result } = renderHook(() => useEditorFile());
    const r = await result.current.saveActive();
    expect(r.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/x.md', 'new');
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(false);
  });

  it('openFileByPath 走 readFile + openTab', async () => {
    const readFile = vi.fn(async () => ({ ok: true, data: 'file content' }));
    installFsApi({
      readFile,
      writeFile: vi.fn(),
    });

    const { result } = renderHook(() => useEditorFile());
    const r = await result.current.openFileByPath('/y.txt');
    expect(r.ok).toBe(true);
    expect(readFile).toHaveBeenCalledWith('/y.txt');
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useEditorStore.getState().tabs[0]?.content).toBe('file content');
  });
});
