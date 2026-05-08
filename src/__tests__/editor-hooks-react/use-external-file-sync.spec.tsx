// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { useExternalFileSync } from '../../panels/Editor/useExternalFileSync';
import { useEditorStore } from '../../stores/editor.store';

interface FsApi {
  onDirChanged: (cb: (dir: string) => void) => () => void;
  readFile: ReturnType<typeof vi.fn>;
}

function installFsApi(fs: FsApi): void {
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

describe('useExternalFileSync', () => {
  it('changedDir = dirname(tab.filePath) + 非 dirty + readFile ok → reloadFromDisk', async () => {
    let dirCb: ((dir: string) => void) | null = null;
    const readFile = vi.fn(async () => ({
      ok: true,
      data: 'fresh from disk',
    }));
    installFsApi({
      onDirChanged: (cb) => {
        dirCb = cb;
        return () => {};
      },
      readFile,
    });

    useEditorStore.setState({
      tabs: [
        {
          id: '/proj/a.md',
          filePath: '/proj/a.md',
          content: 'old',
          originalContent: 'old',
          dirty: false,
        },
      ],
      activeTabId: '/proj/a.md',
    });

    renderHook(() => useExternalFileSync());
    expect(dirCb).not.toBeNull();
    dirCb!('/proj');
    // readFile 是 async,等微任务 flush
    await Promise.resolve();
    await Promise.resolve();

    expect(readFile).toHaveBeenCalledWith('/proj/a.md');
    expect(useEditorStore.getState().tabs[0]?.content).toBe('fresh from disk');
  });

  it('dirty tab → 跳过', async () => {
    let dirCb: ((dir: string) => void) | null = null;
    const readFile = vi.fn(async () => ({ ok: true, data: 'fresh' }));
    installFsApi({
      onDirChanged: (cb) => {
        dirCb = cb;
        return () => {};
      },
      readFile,
    });

    useEditorStore.setState({
      tabs: [
        {
          id: '/proj/a.md',
          filePath: '/proj/a.md',
          content: 'user typing',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/proj/a.md',
    });

    renderHook(() => useExternalFileSync());
    dirCb!('/proj');
    await Promise.resolve();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('changedDir ≠ tab dirname → 跳过', async () => {
    let dirCb: ((dir: string) => void) | null = null;
    const readFile = vi.fn(async () => ({ ok: true, data: 'fresh' }));
    installFsApi({
      onDirChanged: (cb) => {
        dirCb = cb;
        return () => {};
      },
      readFile,
    });

    useEditorStore.setState({
      tabs: [
        {
          id: '/proj/a.md',
          filePath: '/proj/a.md',
          content: 'x',
          originalContent: 'x',
          dirty: false,
        },
      ],
      activeTabId: '/proj/a.md',
    });

    renderHook(() => useExternalFileSync());
    dirCb!('/elsewhere');
    await Promise.resolve();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('readFile ok=false → 跳过(tab content 不变)', async () => {
    let dirCb: ((dir: string) => void) | null = null;
    const readFile = vi.fn(async () => ({
      ok: false,
      code: 'ENOENT',
      message: 'gone',
    }));
    installFsApi({
      onDirChanged: (cb) => {
        dirCb = cb;
        return () => {};
      },
      readFile,
    });

    useEditorStore.setState({
      tabs: [
        {
          id: '/proj/a.md',
          filePath: '/proj/a.md',
          content: 'old',
          originalContent: 'old',
          dirty: false,
        },
      ],
      activeTabId: '/proj/a.md',
    });

    renderHook(() => useExternalFileSync());
    dirCb!('/proj');
    await Promise.resolve();
    await Promise.resolve();
    expect(useEditorStore.getState().tabs[0]?.content).toBe('old');
  });

  it('hook 卸载调返回的 unsub', () => {
    const unsub = vi.fn();
    installFsApi({
      onDirChanged: () => unsub,
      readFile: vi.fn(),
    });

    const { unmount } = renderHook(() => useExternalFileSync());
    expect(unsub).not.toHaveBeenCalled();
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('filePath null(草稿)→ 跳过', async () => {
    let dirCb: ((dir: string) => void) | null = null;
    const readFile = vi.fn(async () => ({ ok: true, data: 'x' }));
    installFsApi({
      onDirChanged: (cb) => {
        dirCb = cb;
        return () => {};
      },
      readFile,
    });

    useEditorStore.setState({
      tabs: [
        {
          id: 'untitled-1',
          filePath: null,
          content: 'x',
          originalContent: '',
          dirty: false,
        },
      ],
      activeTabId: 'untitled-1',
    });

    renderHook(() => useExternalFileSync());
    dirCb!('/');
    await Promise.resolve();
    expect(readFile).not.toHaveBeenCalled();
  });
});
