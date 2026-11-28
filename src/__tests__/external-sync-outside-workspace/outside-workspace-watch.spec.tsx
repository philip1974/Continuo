// @vitest-environment jsdom
// 工作区外(或没打开文件夹时)的文件 tab:可见时 watch(fs:watch-file),不可见 / 关闭释放;外部修改 → 干净 tab 自动重读。
// 不可见期间改了 → 再次可见时按 stat 比对后重读;窗口获焦时比对可见的这类文件。工作区内的文件不走这条路(根 watcher 覆盖)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { useExternalFileSync } from '../../panels/Editor/useExternalFileSync';
import { useExternalSyncRootWatch } from '../../panels/Editor/useExternalSyncRootWatch';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { flushMicrotasks } from '../_helpers/async';

const cleanTab = (p: string, content = 'old'): EditorTab => ({
  id: p,
  filePath: p,
  content,
  originalContent: content,
  dirty: false,
});

/** 模拟 main:磁盘内容 + stat;watchFile 的父目录有变化才广播 dir-changed(同 main 的非递归父目录 watcher)。 */
function installFs() {
  const disk = new Map<string, { data: string; mtimeMs: number }>();
  const watched = new Map<string, number>();
  const subs = new Set<(dir: string, files?: readonly string[]) => void>();
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  const readFile = vi.fn(async (p: string) => {
    const f = disk.get(p);
    return f ? { ok: true, data: f.data } : { ok: false, code: 'FS_NOT_FOUND' };
  });
  const stat = vi.fn(async (p: string) => {
    const f = disk.get(p);
    return f ? { ok: true, data: { mtimeMs: f.mtimeMs, size: f.data.length, ino: 1 } } : { ok: false, code: 'FS_NOT_FOUND' };
  });
  /** main 拒绝 watch 的路径(如另存为的新路径尚未登记)。 */
  const denied = new Set<string>();
  const watchFile = vi.fn(async (p: string) => {
    if (denied.has(p)) return { ok: false, code: 'FS_DENIED' };
    watched.set(p, (watched.get(p) ?? 0) + 1);
    return { ok: true };
  });
  const unwatchFile = vi.fn(async (p: string) => {
    const n = (watched.get(p) ?? 0) - 1;
    if (n > 0) watched.set(p, n);
    else watched.delete(p);
    return { ok: true };
  });
  Object.defineProperty(window, 'api', {
    value: {
      fs: {
        onDirChanged: (cb: (dir: string, files?: readonly string[]) => void) => {
          subs.add(cb);
          return () => subs.delete(cb);
        },
        onWatchLost: () => () => {},
        onRootPresenceChanged: () => () => {},
        watchDir: vi.fn(async () => ({ ok: true })),
        unwatchDir: vi.fn(async () => ({ ok: true })),
        readFile,
        stat,
        watchFile,
        unwatchFile,
      },
    },
    writable: true,
    configurable: true,
  });
  captureLmApi();
  let clock = 1000;
  /** 外部进程写文件:改磁盘;被 watch 的文件所在目录才有事件。 */
  const write = (p: string, data: string) => {
    disk.set(p, { data, mtimeMs: ++clock });
    const covered = [...watched.keys()].some((w) => dirOf(w) === dirOf(p));
    if (covered) for (const cb of subs) cb(dirOf(p), [p.slice(p.lastIndexOf('/') + 1)]);
  };
  return { disk, watched, denied, readFile, stat, watchFile, unwatchFile, write, seed: (p: string, d: string) => disk.set(p, { data: d, mtimeMs: ++clock }) };
}

const content = (id: string) => useEditorStore.getState().tabs.find((t) => t.id === id)?.content;

function mount() {
  return renderHook(() => {
    useExternalFileSync();
    useExternalSyncRootWatch();
  });
}

beforeEach(() => {
  _resetLmApiForTest();
  useEditorStore.setState({ tabs: [], activeTabId: null });
  useWorkspaceStore.setState({ root: null });
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('工作区外文件的外部修改同步', () => {
  it('工作区外的可见文件被外部追加 → watch 其路径并自动重读', async () => {
    const fs = installFs();
    fs.seed('/var/log/app.log', 'line1\n');
    useWorkspaceStore.setState({ root: '/proj' });
    useEditorStore.setState({ tabs: [cleanTab('/var/log/app.log', 'line1\n')], activeTabId: '/var/log/app.log' });
    mount();
    await flushMicrotasks(6);
    expect(fs.watchFile).toHaveBeenCalledWith('/var/log/app.log');

    fs.write('/var/log/app.log', 'line1\nline2\n');
    await flushMicrotasks(6);
    expect(content('/var/log/app.log')).toBe('line1\nline2\n');
  });

  it('没打开文件夹时任何文件都按工作区外处理', async () => {
    const fs = installFs();
    fs.seed('/home/u/notes.txt', 'a');
    useEditorStore.setState({ tabs: [cleanTab('/home/u/notes.txt', 'a')], activeTabId: '/home/u/notes.txt' });
    mount();
    await flushMicrotasks(6);
    fs.write('/home/u/notes.txt', 'ab');
    await flushMicrotasks(6);
    expect(content('/home/u/notes.txt')).toBe('ab');
  });

  it('工作区内的文件、无标题文件、图片不走 fs:watch-file', async () => {
    const fs = installFs();
    useWorkspaceStore.setState({ root: '/proj' });
    useEditorStore.setState({
      tabs: [cleanTab('/proj/a.ts'), cleanTab('untitled:Untitled-1'), cleanTab('/pics/p.png')],
      activeTabId: '/proj/a.ts',
    });
    mount();
    await flushMicrotasks(6);
    act(() => useEditorStore.setState({ activeTabId: 'untitled:Untitled-1' }));
    await flushMicrotasks(6);
    act(() => useEditorStore.setState({ activeTabId: '/pics/p.png' }));
    await flushMicrotasks(6);
    expect(fs.watchFile).not.toHaveBeenCalled();
  });

  it('不可见的 tab 不 watch;切回时磁盘已变 → 重读;关闭全部释放', async () => {
    const fs = installFs();
    fs.seed('/out/a.log', 'A0');
    fs.seed('/out2/b.log', 'B0');
    useWorkspaceStore.setState({ root: '/proj' });
    useEditorStore.setState({ tabs: [cleanTab('/out/a.log', 'A0'), cleanTab('/out2/b.log', 'B0')], activeTabId: '/out/a.log' });
    mount();
    await flushMicrotasks(6);
    expect([...fs.watched.keys()]).toEqual(['/out/a.log']);

    act(() => useEditorStore.setState({ activeTabId: '/out2/b.log' }));
    await flushMicrotasks(6);
    expect([...fs.watched.keys()]).toEqual(['/out2/b.log']);

    // a 不可见期间被改(没有 watcher,无事件)
    fs.write('/out/a.log', 'A1');
    await flushMicrotasks(6);
    expect(content('/out/a.log')).toBe('A0');

    act(() => useEditorStore.setState({ activeTabId: '/out/a.log' }));
    await flushMicrotasks(8);
    expect(content('/out/a.log')).toBe('A1');

    act(() => useEditorStore.setState({ tabs: [], activeTabId: null }));
    await flushMicrotasks(6);
    expect(fs.watched.size).toBe(0);
  });

  it('切回时磁盘未变 → 不重读', async () => {
    const fs = installFs();
    fs.seed('/out/a.log', 'A0');
    fs.seed('/out/b.log', 'B0');
    useEditorStore.setState({ tabs: [cleanTab('/out/a.log', 'A0'), cleanTab('/out/b.log', 'B0')], activeTabId: '/out/a.log' });
    mount();
    await flushMicrotasks(6);
    act(() => useEditorStore.setState({ activeTabId: '/out/b.log' }));
    await flushMicrotasks(6);
    act(() => useEditorStore.setState({ activeTabId: '/out/a.log' }));
    await flushMicrotasks(8);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('窗口获焦:可见的工作区外文件 stat 变了(事件漏了)→ 重读', async () => {
    const fs = installFs();
    fs.seed('/out/a.log', 'A0');
    useEditorStore.setState({ tabs: [cleanTab('/out/a.log', 'A0')], activeTabId: '/out/a.log' });
    mount();
    await flushMicrotasks(6);
    // 绕过 watcher 改磁盘(模拟事件丢失)
    fs.disk.set('/out/a.log', { data: 'A-missed', mtimeMs: 99999 });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flushMicrotasks(8);
    expect(content('/out/a.log')).toBe('A-missed');
  });

  it.each([
    ['窗口获焦', () => window.dispatchEvent(new Event('focus'))],
    ['页面重新可见', () => document.dispatchEvent(new Event('visibilitychange'))],
  ] as const)('watch 被拒 / 失败后,%s时再申请一次;装上后外部修改照常同步;已装上的不重复申请', async (_name, trigger) => {
    const fs = installFs();
    fs.seed('/out/a.log', 'A0');
    fs.denied.add('/out/a.log');
    useEditorStore.setState({ tabs: [cleanTab('/out/a.log', 'A0')], activeTabId: '/out/a.log' });
    mount();
    await flushMicrotasks(6);
    expect(fs.watched.has('/out/a.log')).toBe(false);
    const calls = () => fs.watchFile.mock.calls.filter(([x]) => x === '/out/a.log').length;

    fs.denied.delete('/out/a.log');
    act(() => {
      trigger();
    });
    await flushMicrotasks(8);
    expect(fs.watched.get('/out/a.log')).toBe(1);
    const afterRetry = calls();
    act(() => {
      trigger();
    });
    await flushMicrotasks(8);
    expect(calls()).toBe(afterRetry);
    expect(fs.watched.get('/out/a.log')).toBe(1);

    fs.write('/out/a.log', 'A1');
    await flushMicrotasks(8);
    expect(content('/out/a.log')).toBe('A1');
  });
});
