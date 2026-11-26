// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import {
  EXTERNAL_DELETE_CONFIRM_MS,
  useExternalFileSync,
} from '../../panels/Editor/useExternalFileSync';
import { useEditorStore } from '../../stores/editor.store';
import { emitWatchRestored } from '../../lib/fs-watch-restored';
import {
  _resetSavedDiskStatsForTest,
  recordSavedDiskStat,
} from '../../panels/Editor/saved-disk-stat';
import { flushMicrotasks } from '../_helpers/async';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useExternalSyncRootWatch } from '../../panels/Editor/useExternalSyncRootWatch';

interface FsApi {
  onDirChanged: (cb: (dir: string, files?: readonly string[]) => void) => () => void;
  readFile: ReturnType<typeof vi.fn>;
  watchDir?: ReturnType<typeof vi.fn>;
  unwatchDir?: ReturnType<typeof vi.fn>;
  onWatchLost?: (cb: (path: string) => void) => () => void;
}

function installFsApi(fs: FsApi): void {
  Object.defineProperty(window, 'api', {
    value: { fs: { onWatchLost: () => () => {}, onRootPresenceChanged: () => () => {}, ...fs } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
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

  // 性能:dir-changed 携带变更文件名集合时只重读命中的 clean tab(Markdown 2s 自动保存 / 根目录持续写
  // 日志时不再把同目录所有 clean tab 全量读回);无集合 / 超限时退化为按目录匹配(行为不变)。
  describe('dir-changed 携带变更文件名', () => {
    const tab = (p: string) => ({ id: p, filePath: p, content: 'old', originalContent: 'old', dirty: false });
    function setup() {
      let dirCb: ((dir: string, files?: readonly string[]) => void) | null = null;
      const readFile = vi.fn(async (p: string) => ({ ok: true, data: `new ${p}` }));
      installFsApi({ onDirChanged: (cb) => { dirCb = cb; return () => {}; }, readFile });
      useEditorStore.setState({
        tabs: [tab('/proj/a.md'), tab('/proj/b.md'), tab('/proj/c.md'), tab('/proj/sub/a.md')],
        activeTabId: '/proj/a.md',
      });
      renderHook(() => useExternalFileSync());
      return { emit: (dir: string, files?: readonly string[]) => dirCb!(dir, files), readFile };
    }

    it('有文件集合 → 只重读路径在集合内的 clean tab', async () => {
      const { emit, readFile } = setup();
      emit('/proj', ['b.md', 'log.txt']);
      await Promise.resolve();
      await Promise.resolve();
      expect(readFile.mock.calls.map((c) => c[0])).toEqual(['/proj/b.md']);
      expect(useEditorStore.getState().tabs.map((t) => t.content)).toEqual([
        'old',
        'new /proj/b.md',
        'old',
        'old',
      ]);
    });

    it('rename 事件分别报旧名 / 新名 → 命中任一即重读', async () => {
      const { emit, readFile } = setup();
      emit('/proj', ['a.md.tmp', 'a.md']); // 原子写:临时文件 rename 成目标
      await Promise.resolve();
      expect(readFile.mock.calls.map((c) => c[0])).toEqual(['/proj/a.md']);
    });

    it('无文件集合(缺 filename / 超限退化)→ 按目录匹配重读该目录全部 clean tab', async () => {
      const { emit, readFile } = setup();
      emit('/proj', undefined);
      await Promise.resolve();
      expect(readFile.mock.calls.map((c) => c[0]).sort()).toEqual([
        '/proj/a.md',
        '/proj/b.md',
        '/proj/c.md',
      ]);
    });

    it('文件名比较宽松(大小写 / Unicode NFC-NFD 差异仍命中,宁多读不漏读)', async () => {
      let dirCb: ((dir: string, files?: readonly string[]) => void) | null = null;
      const readFile = vi.fn(async (_p: string) => ({ ok: true, data: 'x' }));
      installFsApi({ onDirChanged: (cb) => { dirCb = cb; return () => {}; }, readFile });
      const nfc = '/proj/café.md';
      useEditorStore.setState({ tabs: [tab('/proj/README.md'), tab(nfc)], activeTabId: nfc });
      renderHook(() => useExternalFileSync());
      dirCb!('/proj', ['readme.md', 'café.md']);
      await Promise.resolve();
      expect(readFile.mock.calls.map((c) => c[0])).toEqual(['/proj/README.md', nfc]);
    });

    // 外部改名 / 移动 / 删除**目录**:macOS 递归 fs.watch 对 `mv /proj/sub /proj/sub2` 只报
    // {dir:/proj, files:[sub, sub2]},不列目录内文件 → 集合中的名字若是 tab 的祖先目录,其子树内 tab 也须检查。
    it('集合中的名字是 tab 的祖先目录(目录改名 / 移动 / 删除)→ 子树内 clean tab 也重读', async () => {
      const { emit, readFile } = setup();
      emit('/proj', ['sub', 'sub2']);
      await Promise.resolve();
      expect(readFile.mock.calls.map((c) => c[0])).toEqual(['/proj/sub/a.md']);
    });

    it('名字只是前缀 / 不是祖先目录段 → 子树 tab 不命中', async () => {
      const { emit, readFile } = setup();
      emit('/proj', ['su', 'sub.md']);
      await Promise.resolve();
      expect(readFile).not.toHaveBeenCalled();
    });

    it('不同目录的同名文件不命中(目录仍按 pathEquals(dirname) 精确匹配)', async () => {
      const { emit, readFile } = setup();
      emit('/proj/sub', ['b.md']);
      await Promise.resolve();
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  // 回归(dir-changed 带文件名后):编辑器打开不做 realpath,tab.filePath 可能是符号链接;FSEvents/inotify
  // 上报的是被实际修改的目录项(链接目标)名。典型 `CLAUDE.md -> AGENTS.md`:外部改 AGENTS.md 只报
  // {dir, ['AGENTS.md']}。tab 记下读盘时 main 解析的 realPath,目录 / 文件名两侧都按 filePath 或 realPath 匹配。
  describe('symlink tab(realPath)', () => {
    const link = (p: string, realPath: string) => ({
      id: p,
      filePath: p,
      realPath,
      content: 'old',
      originalContent: 'old',
      dirty: false,
    });
    const plain = (p: string) => ({ id: p, filePath: p, content: 'old', originalContent: 'old', dirty: false });
    function setup(tabs: ReturnType<typeof plain>[]) {
      let dirCb: ((dir: string, files?: readonly string[]) => void) | null = null;
      const readFile = vi.fn(async (p: string) => ({ ok: true, data: `new ${p}` }));
      installFsApi({ onDirChanged: (cb) => { dirCb = cb; return () => {}; }, readFile });
      useEditorStore.setState({ tabs, activeTabId: tabs[0]!.id });
      renderHook(() => useExternalFileSync());
      return { emit: (dir: string, files?: readonly string[]) => dirCb!(dir, files), readFile };
    }

    it('同目录链接:目标被改(只报目标名)→ 链接 tab 重读(经链接路径读)', async () => {
      const { emit, readFile } = setup([link('/proj/CLAUDE.md', '/proj/AGENTS.md')]);
      emit('/proj', ['AGENTS.md']);
      await Promise.resolve();
      await Promise.resolve();
      expect(readFile.mock.calls.map((c) => c[0])).toEqual(['/proj/CLAUDE.md']);
      expect(useEditorStore.getState().tabs[0]?.content).toBe('new /proj/CLAUDE.md');
    });

    it('跨目录链接:目标所在目录变更(带 / 不带文件名)→ 链接 tab 重读', async () => {
      const { emit, readFile } = setup([link('/proj/link.md', '/other/t.md')]);
      // 真实 main:经链接读盘每次都带回 realPath(tab.realPath 随之保持)
      readFile.mockImplementation(async (p: string) => ({ ok: true, data: `new ${p}`, realPath: '/other/t.md' }));
      emit('/other', ['t.md']);
      await flushMicrotasks(4);
      emit('/other', undefined);
      await flushMicrotasks(4);
      expect(readFile.mock.calls.map((c) => c[0])).toEqual(['/proj/link.md', '/proj/link.md']);
      expect(useEditorStore.getState().tabs[0]?.realPath).toBe('/other/t.md');
      emit('/other', ['unrelated.md']);
      await flushMicrotasks(4);
      expect(readFile).toHaveBeenCalledTimes(2);
    });

    it('链接自身目录项被改(报链接名)仍重读;非链接 tab 行为不变', async () => {
      const { emit, readFile } = setup([link('/proj/CLAUDE.md', '/other/t.md'), plain('/proj/a.md')]);
      emit('/proj', ['CLAUDE.md']);
      await Promise.resolve();
      expect(readFile.mock.calls.map((c) => c[0])).toEqual(['/proj/CLAUDE.md']);
      emit('/proj', ['t.md']); // 目标名但不在目标目录 /other → 非链接 a.md 不命中
      await Promise.resolve();
      await Promise.resolve();
      emit('/other', ['a.md']); // 非链接 tab 只按自身目录匹配
      await Promise.resolve();
      expect(readFile.mock.calls.map((c) => c[0]).filter((p) => p === '/proj/a.md')).toEqual([]);
    });

    it('watch-restored:目标在恢复的子树内 → 链接 tab 重读', async () => {
      const { readFile } = setup([link('/proj/link.md', '/other/deep/t.md')]);
      emitWatchRestored('/other');
      await Promise.resolve();
      await Promise.resolve();
      expect(readFile.mock.calls.map((c) => c[0])).toEqual(['/proj/link.md']);
    });

    it('重读结果带新的 realPath → tab.realPath 随之更新', async () => {
      let dirCb: ((dir: string, files?: readonly string[]) => void) | null = null;
      const readFile = vi.fn(async () => ({ ok: true, data: 'retargeted', realPath: '/new/T.md' }));
      installFsApi({ onDirChanged: (cb) => { dirCb = cb; return () => {}; }, readFile });
      useEditorStore.setState({ tabs: [link('/proj/l.md', '/old/T.md')], activeTabId: '/proj/l.md' });
      renderHook(() => useExternalFileSync());
      dirCb!('/old', ['T.md']);
      await Promise.resolve();
      await Promise.resolve();
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'retargeted', realPath: '/new/T.md' });
    });
  });

  // 内存:watch-restored 对子树内所有 clean tab 重读,此前同时发起全部 readFile(256 tab × 大文件 →
  // main 峰值内存 GB 级)。改为有界并发(上限 32,同 hydrateEditorTabs RESTORE_READ_CONCURRENCY)。
  it('watch-restored 子树重读峰值在途 ≤ 32,全部 tab 最终都被重读', async () => {
    let inflight = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const readFile = vi.fn(
      (p: string) =>
        new Promise<{ ok: true; data: string }>((resolve) => {
          inflight += 1;
          peak = Math.max(peak, inflight);
          resolvers.push(() => {
            inflight -= 1;
            resolve({ ok: true, data: `new ${p}` });
          });
        }),
    );
    installFsApi({ onDirChanged: () => () => {}, readFile });
    const paths = Array.from({ length: 100 }, (_, i) => `/proj/f${i}.md`);
    useEditorStore.setState({
      tabs: paths.map((p) => ({ id: p, filePath: p, content: 'old', originalContent: 'old', dirty: false })),
      activeTabId: paths[0]!,
    });
    renderHook(() => useExternalFileSync());
    emitWatchRestored('/proj');
    for (let round = 0; round < 20; round++) {
      for (const r of resolvers.splice(0)) r();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(32);
    expect(readFile.mock.calls.map((c) => c[0]).sort()).toEqual([...paths].sort());
    expect(useEditorStore.getState().tabs.every((t) => t.content === `new ${t.filePath}`)).toBe(true);
  });

  it('watch-restored 排队期间该 path 已被 dir-changed 读取在途 → 不并发重复读(合并为尾随一次)', async () => {
    let dirCb: ((dir: string, files?: readonly string[]) => void) | null = null;
    const resolvers: Array<() => void> = [];
    let heldF39: (() => void) | null = null; // dir-changed 发起的 f39 读一直挂着,直到排队项都已派发
    const inflightByPath = new Map<string, number>();
    let maxPerPath = 0;
    const readFile = vi.fn(
      (p: string) =>
        new Promise<{ ok: true; data: string }>((resolve) => {
          const n = (inflightByPath.get(p) ?? 0) + 1;
          inflightByPath.set(p, n);
          maxPerPath = Math.max(maxPerPath, n);
          const done = () => {
            inflightByPath.set(p, (inflightByPath.get(p) ?? 1) - 1);
            resolve({ ok: true, data: `new ${p}` });
          };
          if (p === '/proj/f39.md' && heldF39 === null) heldF39 = done;
          else resolvers.push(done);
        }),
    );
    installFsApi({ onDirChanged: (cb) => { dirCb = cb; return () => {}; }, readFile });
    const paths = Array.from({ length: 40 }, (_, i) => `/proj/f${i}.md`);
    useEditorStore.setState({
      tabs: paths.map((p) => ({ id: p, filePath: p, content: 'old', originalContent: 'old', dirty: false })),
      activeTabId: paths[0]!,
    });
    renderHook(() => useExternalFileSync());
    emitWatchRestored('/proj'); // 前 32 个立即读,f32..f39 排队
    dirCb!('/proj', ['f39.md']); // 排队中的 path 被 dir-changed 先读
    for (let round = 0; round < 20; round++) {
      for (const r of resolvers.splice(0)) r();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    expect(maxPerPath).toBe(1); // 排队到 f39 时它仍在途 → 不得并发第二个读
    (heldF39 as (() => void) | null)?.();
    for (let round = 0; round < 5; round++) {
      for (const r of resolvers.splice(0)) r(); // 尾随重读
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    expect(readFile.mock.calls.filter((c) => c[0] === '/proj/f39.md')).toHaveLength(2);
    expect(useEditorStore.getState().tabs.every((t) => t.content === `new ${t.filePath}`)).toBe(true);
  });
});

// 性能:编辑器自己保存的回声(原子写 tmp + rename 让 watcher 上报被保存文件本身)。有本 tab 当前基线的保存
// 记录时先廉价 stat 比对:一致 → 跳过整文件 readFile;stat 变化 / 失败 → 照旧读(不凭「刚保存过」跳过)。
describe('useExternalFileSync · 保存回声识别', () => {
  const SAVED = { mtimeMs: 1000.5, size: 5, ino: 77 };

  function setupEcho(stat: ReturnType<typeof vi.fn>, readData = 'saved') {
    let dirCb: ((dir: string, files?: readonly string[]) => void) | null = null;
    const readFile = vi.fn(async () => ({ ok: true, data: readData }));
    Object.defineProperty(window, 'api', {
      value: {
        fs: {
          onDirChanged: (cb: (dir: string, files?: readonly string[]) => void) => {
            dirCb = cb;
            return () => {};
          },
          onRootPresenceChanged: () => () => {},
          readFile,
          stat,
        },
      },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    useEditorStore.setState({
      tabs: [
        {
          id: '/proj/a.md',
          filePath: '/proj/a.md',
          content: 'saved',
          originalContent: 'saved',
          dirty: false,
        },
      ],
      activeTabId: '/proj/a.md',
    });
    const gen = recordSavedDiskStat('/proj/a.md', SAVED);
    useEditorStore.getState().markSaved('/proj/a.md', 'saved', gen);
    renderHook(() => useExternalFileSync());
    return { fire: () => dirCb!('/proj', ['.a.md.continuo.tmp', 'a.md']), readFile };
  }

  beforeEach(() => _resetSavedDiskStatsForTest());

  it('stat 与保存记录一致 → 不 readFile', async () => {
    const stat = vi.fn(async () => ({ ok: true, data: { ...SAVED } }));
    const { fire, readFile } = setupEcho(stat);
    fire();
    await flushMicrotasks(6);
    expect(stat).toHaveBeenCalledWith('/proj/a.md');
    expect(readFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0]?.content).toBe('saved');
  });

  it('保存后外部又改写(mtime / size 变化)→ 照旧 readFile 并 reload', async () => {
    const stat = vi.fn(async () => ({ ok: true, data: { mtimeMs: 2000, size: 8 } }));
    const { fire, readFile } = setupEcho(stat, 'external');
    fire();
    await flushMicrotasks(6);
    expect(readFile).toHaveBeenCalledWith('/proj/a.md');
    expect(useEditorStore.getState().tabs[0]?.content).toBe('external');
  });

  it('仅 mtime 变化(同 size)也照旧读', async () => {
    const stat = vi.fn(async () => ({ ok: true, data: { mtimeMs: 1000.6, size: 5 } }));
    const { fire, readFile } = setupEcho(stat, 'other');
    fire();
    await flushMicrotasks(6);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().tabs[0]?.content).toBe('other');
  });

  it('mtime / size 相同但 ino 不同(粗粒度 mtime 文件系统上同大小外部替换)→ 照旧读', async () => {
    const stat = vi.fn(async () => ({ ok: true, data: { ...SAVED, ino: 78 } }));
    const { fire, readFile } = setupEcho(stat, 'replaced');
    fire();
    await flushMicrotasks(6);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().tabs[0]?.content).toBe('replaced');
  });

  it('stat 失败({ok:false} 或 reject)→ 照旧读', async () => {
    const statFail = vi.fn(async () => ({ ok: false, code: 'FS_IO', message: 'x' }));
    const a = setupEcho(statFail, 'disk');
    a.fire();
    await flushMicrotasks(6);
    expect(a.readFile).toHaveBeenCalledTimes(1);
    cleanup();

    const statReject = vi.fn(async () => {
      throw new Error('bridge down');
    });
    const b = setupEcho(statReject, 'disk2');
    b.fire();
    await flushMicrotasks(6);
    expect(b.readFile).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().tabs[0]?.content).toBe('disk2');
  });

  it('保存代际不匹配(关闭后重开同路径的新 tab 无 savedGen)→ 不发 stat,直接读', async () => {
    const stat = vi.fn(async () => ({ ok: true, data: { ...SAVED } }));
    const { fire, readFile } = setupEcho(stat, 'reopened');
    useEditorStore.setState({
      tabs: [{ id: '/proj/a.md', filePath: '/proj/a.md', content: 'saved', originalContent: 'saved', dirty: false }],
      activeTabId: '/proj/a.md',
    });
    fire();
    await flushMicrotasks(6);
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('记录不再对应 tab 当前基线(其后被外部 reload 换过内容)→ 不发 stat,直接读', async () => {
    const stat = vi.fn(async () => ({ ok: true, data: { ...SAVED } }));
    const { fire, readFile } = setupEcho(stat, 'newer');
    useEditorStore.getState().reloadFromDisk('/proj/a.md', 'reloaded');
    fire();
    await flushMicrotasks(6);
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});

// 外部删除 / 改名(对齐 VSCode closeOnFileDelete: false):干净 tab 不关,保留并标「已删除」(editor store
// markPathsDeleted;自动保存不写回,手动保存重建)。读到不存在先等 EXTERNAL_DELETE_CONFIRM_MS 再确认一次,避免
// 「先删后建」原子替换间隙误标。资源管理器删除(removePaths)仍关闭干净 tab。
describe('外部删除 / 改名(读到 FS_NOT_FOUND)', () => {
  const NF = { ok: false, code: 'FS_NOT_FOUND', message: 'gone' };
  const cleanTab = { id: '/proj/a.md', filePath: '/proj/a.md', content: 'old', originalContent: 'old', dirty: false };
  function setup(readFile: ReturnType<typeof vi.fn>, tab: typeof cleanTab = cleanTab) {
    let dirCb: ((dir: string, files?: readonly string[]) => void) | null = null;
    installFsApi({ onDirChanged: (cb) => { dirCb = cb; return () => {}; }, readFile });
    useEditorStore.setState({ tabs: [tab], activeTabId: tab.id });
    renderHook(() => useExternalFileSync());
    return () => dirCb!('/proj', ['a.md']);
  }
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('干净 tab:确认仍不存在 → 保留并标记已删除(确认前不标记)', async () => {
    const readFile = vi.fn(async () => NF);
    const fire = setup(readFile);
    fire();
    await flushMicrotasks(6);
    expect(useEditorStore.getState().tabs[0]?.orphaned).toBeFalsy();
    await vi.advanceTimersByTimeAsync(EXTERNAL_DELETE_CONFIRM_MS);
    await flushMicrotasks(6);
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(useEditorStore.getState().tabs).toMatchObject([{ id: '/proj/a.md', orphaned: true, content: 'old' }]);
    expect(useEditorStore.getState().activeTabId).toBe('/proj/a.md');
  });

  it('确认等待期间 tab 被编辑(变脏)→ 保留', async () => {
    const readFile = vi.fn(async () => NF);
    const fire = setup(readFile);
    fire();
    await flushMicrotasks(6);
    useEditorStore.getState().updateContent('/proj/a.md', 'user typing');
    await vi.advanceTimersByTimeAsync(EXTERNAL_DELETE_CONFIRM_MS);
    await flushMicrotasks(6);
    expect(useEditorStore.getState().tabs.map((t) => [t.id, t.content, t.dirty])).toEqual([
      ['/proj/a.md', 'user typing', true],
    ]);
  });

  it('脏 tab → 保留(不读盘)', async () => {
    const readFile = vi.fn(async () => NF);
    const fire = setup(readFile, { ...cleanTab, content: 'edit', dirty: true });
    fire();
    await vi.advanceTimersByTimeAsync(EXTERNAL_DELETE_CONFIRM_MS);
    await flushMicrotasks(6);
    expect(useEditorStore.getState().tabs).toHaveLength(1);
  });

  it('原子替换间隙(先 NOT_FOUND 后又存在)→ 不关,应用新内容', async () => {
    const readFile = vi.fn().mockResolvedValueOnce(NF).mockResolvedValue({ ok: true, data: 'replaced' });
    const fire = setup(readFile);
    fire();
    await flushMicrotasks(6);
    await vi.advanceTimersByTimeAsync(EXTERNAL_DELETE_CONFIRM_MS);
    await flushMicrotasks(6);
    expect(useEditorStore.getState().tabs.map((t) => t.content)).toEqual(['replaced']);
  });

  it('目录被外部改名 / 删除(只报目录名)→ 目录内干净 tab 确认不存在后标记已删除,目录外 tab 不动', async () => {
    const readFile = vi.fn(async (_p: string) => NF);
    let dirCb: ((dir: string, files?: readonly string[]) => void) | null = null;
    installFsApi({ onDirChanged: (cb) => { dirCb = cb; return () => {}; }, readFile });
    const tab = (p: string) => ({ ...cleanTab, id: p, filePath: p });
    useEditorStore.setState({ tabs: [tab('/proj/foo/deep/a.ts'), tab('/proj/b.ts')], activeTabId: '/proj/b.ts' });
    renderHook(() => useExternalFileSync());
    dirCb!('/proj', ['foo', 'bar']);
    await flushMicrotasks(6);
    await vi.advanceTimersByTimeAsync(EXTERNAL_DELETE_CONFIRM_MS);
    await flushMicrotasks(6);
    expect(readFile.mock.calls.map((c) => c[0])).toEqual(['/proj/foo/deep/a.ts', '/proj/foo/deep/a.ts']);
    expect(useEditorStore.getState().tabs.map((t) => [t.id, !!t.orphaned])).toEqual([
      ['/proj/foo/deep/a.ts', true],
      ['/proj/b.ts', false],
    ]);
  });

  it('其它读失败(非 FS_NOT_FOUND)→ 仍只跳过,不关、不标记', async () => {
    const readFile = vi.fn(async () => ({ ok: false, code: 'FS_IO', message: 'x' }));
    const fire = setup(readFile);
    fire();
    await vi.advanceTimersByTimeAsync(EXTERNAL_DELETE_CONFIRM_MS);
    await flushMicrotasks(6);
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useEditorStore.getState().tabs[0]?.orphaned).toBeFalsy();
  });
});

// 外部同步不依赖 Explorer 是否可见(VSCode:FileService 统一 watch 工作区)。此前同步完全复用 Explorer
// 文件树的 watcher:侧栏持久化为关闭时文件树从不挂载、不装 watcher → 整个会话所有 tab 收不到外部修改。
// 现在有打开的 tab 时由 useExternalSyncRootWatch(与 useExternalFileSync 同由常驻 MainApp 承载)持有
// workspace root 的 watcher(main 按 path 引用计数,与 Explorer
// 的 root watcher 共享同一个 fs.watch;同 tick 同路径广播合并,不重复事件)。
describe('外部同步自持 workspace root watcher(不依赖侧栏 / 文件树挂载)', () => {
  const cleanTab = (p: string) => ({ id: p, filePath: p, content: 'old', originalContent: 'old', dirty: false });

  /** 模拟 main:只有被 watch 的目录(macOS/Win 递归)覆盖的变化才广播 dir-changed。 */
  function installWatchingFs() {
    const watched = new Map<string, number>();
    const subs = new Set<(dir: string, files?: readonly string[]) => void>();
    const readFile = vi.fn(async (p: string) => ({ ok: true, data: `new ${p}` }));
    const watchDir = vi.fn(async (p: string) => {
      watched.set(p, (watched.get(p) ?? 0) + 1);
      return { ok: true };
    });
    const unwatchDir = vi.fn(async (p: string) => {
      const n = (watched.get(p) ?? 0) - 1;
      if (n > 0) watched.set(p, n);
      else watched.delete(p);
      return { ok: true };
    });
    installFsApi({
      onDirChanged: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      readFile,
      watchDir,
      unwatchDir,
    });
    const externalChange = (dir: string, files: readonly string[]) => {
      const covered = [...watched.keys()].some((w) => dir === w || dir.startsWith(`${w}/`));
      if (covered) for (const cb of subs) cb(dir, files);
    };
    return { readFile, watchDir, unwatchDir, watched, externalChange };
  }

  it('侧栏从未打开(无 Explorer watcher):有 tab 时 watch root,深层文件被外部修改 → 干净 tab 重读', async () => {
    const fs = installWatchingFs();
    useWorkspaceStore.setState({ root: '/proj' });
    useEditorStore.setState({ tabs: [cleanTab('/proj/sub/a.md')], activeTabId: '/proj/sub/a.md' });
    renderHook(() => {
      useExternalFileSync();
      useExternalSyncRootWatch();
    });
    await flushMicrotasks(4);
    expect(fs.watchDir).toHaveBeenCalledWith('/proj');
    fs.externalChange('/proj/sub', ['a.md']);
    await flushMicrotasks(4);
    expect(fs.readFile).toHaveBeenCalledWith('/proj/sub/a.md');
    expect(useEditorStore.getState().tabs[0]?.content).toBe('new /proj/sub/a.md');
  });

  it('没有打开的 tab → 不 watch;tab 全关 / root 切换 / 卸载 → 释放(引用计数归零)', async () => {
    const fs = installWatchingFs();
    useWorkspaceStore.setState({ root: '/proj' });
    const hook = renderHook(() => useExternalSyncRootWatch());
    await flushMicrotasks(4);
    expect(fs.watchDir).not.toHaveBeenCalled();

    act(() => useEditorStore.setState({ tabs: [cleanTab('/proj/a.md')], activeTabId: '/proj/a.md' }));
    await flushMicrotasks(4);
    expect([...fs.watched.keys()]).toEqual(['/proj']);

    act(() => useWorkspaceStore.setState({ root: '/other' }));
    await flushMicrotasks(4);
    expect([...fs.watched.keys()]).toEqual(['/other']);

    act(() => useEditorStore.setState({ tabs: [], activeTabId: null }));
    await flushMicrotasks(4);
    expect(fs.watched.size).toBe(0);

    act(() => useEditorStore.setState({ tabs: [cleanTab('/other/a.md')], activeTabId: '/other/a.md' }));
    await flushMicrotasks(4);
    hook.unmount();
    await flushMicrotasks(4);
    expect(fs.watched.size).toBe(0);
  });
});
