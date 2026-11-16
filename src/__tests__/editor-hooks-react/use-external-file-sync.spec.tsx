// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { useExternalFileSync } from '../../panels/Editor/useExternalFileSync';
import { useEditorStore } from '../../stores/editor.store';
import { emitWatchRestored } from '../../lib/fs-watch-restored';

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

  it('目录 watcher 失效后重新可观察(本地 watch-restored)→ 同 dir-changed 重读其中 clean tab', async () => {
    const readFile = vi.fn(async () => ({ ok: true, data: 'changed while lost' }));
    installFsApi({ onDirChanged: () => () => {}, readFile });
    useEditorStore.setState({
      tabs: [
        { id: '/proj/a.md', filePath: '/proj/a.md', content: 'old', originalContent: 'old', dirty: false },
      ],
      activeTabId: '/proj/a.md',
    });
    const hook = renderHook(() => useExternalFileSync());
    emitWatchRestored('/proj');
    await Promise.resolve();
    await Promise.resolve();
    expect(readFile).toHaveBeenCalledWith('/proj/a.md');
    expect(useEditorStore.getState().tabs[0]?.content).toBe('changed while lost');
    hook.unmount();
    emitWatchRestored('/proj'); // 卸载后退订
    expect(readFile).toHaveBeenCalledTimes(1);
  });
  it('watch-restored 覆盖该目录子树(递归 watcher 断线期间子目录变化也丢失)→ 深层 clean tab 也重读', async () => {
    const readFile = vi.fn(async (p: string) => ({ ok: true, data: `new ${p}` }));
    installFsApi({ onDirChanged: () => () => {}, readFile });
    const tab = (p: string) => ({ id: p, filePath: p, content: 'old', originalContent: 'old', dirty: false });
    useEditorStore.setState({
      tabs: [tab('/proj/a.md'), tab('/proj/sub/deep/b.md'), tab('/project2/c.md'), tab('/other/d.md')],
      activeTabId: '/proj/a.md',
    });
    renderHook(() => useExternalFileSync());
    emitWatchRestored('/proj');
    await Promise.resolve();
    await Promise.resolve();
    expect(readFile.mock.calls.map((c) => c[0]).sort()).toEqual(['/proj/a.md', '/proj/sub/deep/b.md']);
  });

  it('普通 dir-changed 仍只命中直接父目录(不扩到子树)', async () => {
    let dirCb: ((dir: string) => void) | null = null;
    const readFile = vi.fn(async () => ({ ok: true, data: 'x' }));
    installFsApi({ onDirChanged: (cb) => { dirCb = cb; return () => {}; }, readFile });
    useEditorStore.setState({
      tabs: [{ id: '/proj/sub/b.md', filePath: '/proj/sub/b.md', content: 'old', originalContent: 'old', dirty: false }],
      activeTabId: '/proj/sub/b.md',
    });
    renderHook(() => useExternalFileSync());
    dirCb!('/proj');
    await Promise.resolve();
    expect(readFile).not.toHaveBeenCalled();
  });
});
