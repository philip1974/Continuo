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
import {
  _resetSavedDiskStatsForTest,
  recordSavedDiskStat,
} from '../../panels/Editor/saved-disk-stat';

interface FsApi {
  onDirChanged: (cb: (dir: string, files?: readonly string[]) => void) => () => void;
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
      const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
      emit('/other', ['t.md']);
      await flush();
      emit('/other', undefined);
      await flush();
      expect(readFile.mock.calls.map((c) => c[0])).toEqual(['/proj/link.md', '/proj/link.md']);
      expect(useEditorStore.getState().tabs[0]?.realPath).toBe('/other/t.md');
      emit('/other', ['unrelated.md']);
      await flush();
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
  const SAVED = { mtimeMs: 1000.5, size: 5 };

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

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  beforeEach(() => _resetSavedDiskStatsForTest());

  it('stat 与保存记录一致 → 不 readFile', async () => {
    const stat = vi.fn(async () => ({ ok: true, data: { ...SAVED } }));
    const { fire, readFile } = setupEcho(stat);
    fire();
    await flush();
    expect(stat).toHaveBeenCalledWith('/proj/a.md');
    expect(readFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0]?.content).toBe('saved');
  });

  it('保存后外部又改写(mtime / size 变化)→ 照旧 readFile 并 reload', async () => {
    const stat = vi.fn(async () => ({ ok: true, data: { mtimeMs: 2000, size: 8 } }));
    const { fire, readFile } = setupEcho(stat, 'external');
    fire();
    await flush();
    expect(readFile).toHaveBeenCalledWith('/proj/a.md');
    expect(useEditorStore.getState().tabs[0]?.content).toBe('external');
  });

  it('仅 mtime 变化(同 size)也照旧读', async () => {
    const stat = vi.fn(async () => ({ ok: true, data: { mtimeMs: 1000.6, size: 5 } }));
    const { fire, readFile } = setupEcho(stat, 'other');
    fire();
    await flush();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().tabs[0]?.content).toBe('other');
  });

  it('stat 失败({ok:false} 或 reject)→ 照旧读', async () => {
    const statFail = vi.fn(async () => ({ ok: false, code: 'FS_IO', message: 'x' }));
    const a = setupEcho(statFail, 'disk');
    a.fire();
    await flush();
    expect(a.readFile).toHaveBeenCalledTimes(1);
    cleanup();

    const statReject = vi.fn(async () => {
      throw new Error('bridge down');
    });
    const b = setupEcho(statReject, 'disk2');
    b.fire();
    await flush();
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
    await flush();
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('记录不再对应 tab 当前基线(其后被外部 reload 换过内容)→ 不发 stat,直接读', async () => {
    const stat = vi.fn(async () => ({ ok: true, data: { ...SAVED } }));
    const { fire, readFile } = setupEcho(stat, 'newer');
    useEditorStore.getState().reloadFromDisk('/proj/a.md', 'reloaded');
    fire();
    await flush();
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
