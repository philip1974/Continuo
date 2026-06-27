import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  findEditorFileTabById,
  findEditorFileTabByPath,
  openFileByPath,
  saveFile,
  type EditorFileDeps,
} from '../../panels/Editor/editor-file-actions';
import {
  createTab,
  useEditorStore,
} from '../../stores/editor.store';
import type { IpcResult } from '../../lib/fs/types';

const ok = <T,>(data: T): IpcResult<T> => ({ ok: true, data });
const fail = (code: string, message = code): IpcResult<never> => ({
  ok: false,
  code,
  message,
});

const makeDeps = (overrides: Partial<EditorFileDeps['fs']> = {}): EditorFileDeps => ({
  fs: {
    readFile: vi.fn(async () => ok('')),
    writeFile: vi.fn(async () => ok(undefined as void)),
    ...overrides,
  },
  store: useEditorStore,
});

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    mode: 'edit',
  });
});

// ────────────────────────────────────────────────────────────
// openFileByPath
// ────────────────────────────────────────────────────────────

describe('editor-file-actions tab lookup helpers', () => {
  it('按 path 查找单趟扫描,不调用 tabs.find', () => {
    const tabs = [createTab('/x/a.md', 'a'), createTab('/x/b.md', 'b')];
    const findSpy = vi.spyOn(tabs, 'find');

    try {
      expect(findEditorFileTabByPath(tabs, '/x/b.md')).toBe(tabs[1]);
      expect(findEditorFileTabByPath(tabs, '/x/missing.md')).toBeNull();
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  it('按 id 查找单趟扫描,不调用 tabs.find', () => {
    const tabs = [createTab('/x/a.md', 'a'), createTab('/x/b.md', 'b')];
    const findSpy = vi.spyOn(tabs, 'find');

    try {
      expect(findEditorFileTabById(tabs, '/x/a.md')).toBe(tabs[0]);
      expect(findEditorFileTabById(tabs, '/x/missing.md')).toBeNull();
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });
});

describe('openFileByPath', () => {
  it('新文件:fs.readFile → createTab + openTab,active 变', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => ok('hello world')),
    });
    const r = await openFileByPath('/x/a.md', deps);
    expect(r.ok).toBe(true);
    const s = useEditorStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({
      id: '/x/a.md',
      filePath: '/x/a.md',
      content: 'hello world',
      originalContent: 'hello world',
      dirty: false,
    });
    expect(s.activeTabId).toBe('/x/a.md');
    expect(deps.fs.readFile).toHaveBeenCalledWith('/x/a.md');
  });

  it('已开过同 path → 不重读,只 switchTab', async () => {
    const existing = createTab('/x/a.md', 'cached');
    useEditorStore.setState({
      tabs: [existing, createTab('/x/b.md', 'b')],
      activeTabId: '/x/b.md',
    });
    const deps = makeDeps({
      readFile: vi.fn(async () => ok('SHOULD-NOT-BE-USED')),
    });
    const r = await openFileByPath('/x/a.md', deps);
    expect(r.ok).toBe(true);
    expect(useEditorStore.getState().activeTabId).toBe('/x/a.md');
    expect(useEditorStore.getState().tabs).toHaveLength(2);
    // 内容仍是 cached(不重读覆盖)
    expect(useEditorStore.getState().tabs[0]?.content).toBe('cached');
    expect(deps.fs.readFile).not.toHaveBeenCalled();
  });

  // 跨平台(codex 复查 P1):去重用平台感知 pathEquals。Windows 上同一文件不同大小写打开
  // 不得开两个 tab(否则分别保存 → 后者覆盖前者丢改);只切到已开 tab 的真实 id,不重读。
  it('Windows 大小写不敏感:同文件不同大小写 → 不开新 tab,只切已开', async () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });
    try {
      useEditorStore.setState({
        tabs: [createTab('C:\\Repo\\a.md', 'cached')],
        activeTabId: null,
      });
      const readFile = vi.fn(async () => ok('SHOULD-NOT-BE-USED'));
      const r = await openFileByPath('c:\\repo\\a.md', makeDeps({ readFile }));
      expect(r.ok).toBe(true);
      expect(useEditorStore.getState().tabs).toHaveLength(1); // 未开新 tab
      expect(useEditorStore.getState().activeTabId).toBe('C:\\Repo\\a.md'); // 切已开真实 id
      expect(readFile).not.toHaveBeenCalled(); // 不重读
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
      else delete (navigator as { platform?: string }).platform;
    }
  });

  it('POSIX 大小写敏感:不同大小写视为不同文件 → 开新 tab', async () => {
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    useEditorStore.setState({
      tabs: [createTab('/repo/a.md', 'cached')],
      activeTabId: null,
    });
    const r = await openFileByPath(
      '/repo/A.md',
      makeDeps({ readFile: vi.fn(async () => ok('new')) }),
    );
    expect(r.ok).toBe(true);
    expect(useEditorStore.getState().tabs).toHaveLength(2); // 不同文件
  });

  it('fs.readFile IpcFail → 不 open,返 IpcFail 透传', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => fail('FS_NOT_FOUND', 'gone')),
    });
    const r = await openFileByPath('/x/missing', deps);
    expect(r).toEqual({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' });
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });

  it('fs.readFile 抛 → 不 crash,返 EXCEPTION', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const r = await openFileByPath('/x/a', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('EXCEPTION');
      expect(r.message).toContain('boom');
    }
  });

  // race(R20):check→read→create 之间的 TOCTOU。并发打开同一文件,两调用都在读前看不到
  // existing,读后须用 pathEquals 复检,只建一个 tab,另一个切换 —— 否则同一磁盘文件两个 tab。
  it('R20 并发打开同一文件 → 只建一个 tab(读后复检去重)', async () => {
    let resolve1!: (v: IpcResult<string>) => void;
    let resolve2!: (v: IpcResult<string>) => void;
    const readFile = vi
      .fn<(p: string) => Promise<IpcResult<string>>>()
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolve1 = res;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolve2 = res;
          }),
      );
    const deps = makeDeps({ readFile });

    // 两次并发打开同一文件(读前都看不到 existing)
    const p1 = openFileByPath('/x/a.md', deps);
    const p2 = openFileByPath('/x/a.md', deps);

    resolve1(ok('content-1')); // 第一个读完 → 建 tab
    await p1;
    resolve2(ok('content-2')); // 第二个读完 → 复检发现已存在 → 只切换
    await p2;

    const paths = useEditorStore.getState().tabs.map((t) => t.filePath ?? t.id);
    expect(paths).toEqual(['/x/a.md']); // 只一个 tab,不重复
  });

  it('R20 并发打开同一文件不同大小写 → pathEquals 复检仍只一个 tab(Windows)', async () => {
    // 强制 Windows 运行时(pathEquals 大小写不敏感)。
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });
    try {
      let r1!: (v: IpcResult<string>) => void;
      let r2!: (v: IpcResult<string>) => void;
      const readFile = vi
        .fn<(p: string) => Promise<IpcResult<string>>>()
        .mockImplementationOnce(() => new Promise((res) => (r1 = res)))
        .mockImplementationOnce(() => new Promise((res) => (r2 = res)));
      const deps = makeDeps({ readFile });

      const p1 = openFileByPath('C:\\Repo\\a.md', deps);
      const p2 = openFileByPath('c:\\repo\\a.md', deps);
      r1(ok('x'));
      await p1;
      r2(ok('y'));
      await p2;

      expect(useEditorStore.getState().tabs).toHaveLength(1);
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
    }
  });
});

// ────────────────────────────────────────────────────────────
// saveFile
// ────────────────────────────────────────────────────────────

describe('saveFile', () => {
  it('成功 → fs.writeFile + store.markSaved,dirty=false', async () => {
    useEditorStore.setState({
      tabs: [
        {
          id: '/x/a.md',
          filePath: '/x/a.md',
          content: 'new content',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/x/a.md',
      mode: 'edit',
    });
    const writeFile = vi.fn(async () => ok(undefined as void));
    const deps = makeDeps({ writeFile });
    const r = await saveFile('/x/a.md', deps);
    expect(r.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/x/a.md', 'new content');
    const tab = useEditorStore.getState().tabs[0];
    expect(tab?.dirty).toBe(false);
    expect(tab?.originalContent).toBe('new content');
  });

  it('tab 不存在 → ok:false code=TAB_NOT_FOUND', async () => {
    const r = await saveFile('/zombie', makeDeps());
    expect(r).toEqual({
      ok: false,
      code: 'TAB_NOT_FOUND',
      message: expect.any(String),
    });
  });

  it('untitled tab(无 filePath)→ ok:false code=UNSAVED_DRAFT', async () => {
    const draft = createTab(null, 'draft');
    useEditorStore.setState({ tabs: [draft], activeTabId: draft.id });
    const r = await saveFile(draft.id, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('UNSAVED_DRAFT');
  });

  it('fs.writeFile IpcFail → 透传,store 不 markSaved', async () => {
    useEditorStore.setState({
      tabs: [
        {
          id: '/x/a',
          filePath: '/x/a',
          content: 'new',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/x/a',
      mode: 'edit',
    });
    const deps = makeDeps({
      writeFile: vi.fn(async () => fail('FS_DENIED', 'no perm')),
    });
    const r = await saveFile('/x/a', deps);
    expect(r).toEqual({ ok: false, code: 'FS_DENIED', message: 'no perm' });
    // 仍然 dirty
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true);
  });

  it('fs.writeFile 抛 → 返 EXCEPTION,store 不变', async () => {
    useEditorStore.setState({
      tabs: [
        {
          id: '/x/a',
          filePath: '/x/a',
          content: 'new',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/x/a',
      mode: 'edit',
    });
    const deps = makeDeps({
      writeFile: vi.fn(async () => {
        throw new Error('disk');
      }),
    });
    const r = await saveFile('/x/a', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EXCEPTION');
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true);
  });

  // race(R21):同一 tab 的并发保存须按发起顺序串行写盘 —— 否则旧内容(autosave)晚于新内容
  // (手动保存)完成会覆盖磁盘。串行后:第一个 write 完成才启动第二个 write,最后发起者最后落盘。
  it('R21 同 tab 并发保存 → 串行写盘(第二个 write 在第一个完成后才启动)', async () => {
    useEditorStore.setState({
      tabs: [
        {
          id: '/x/a',
          filePath: '/x/a',
          content: 'A',
          originalContent: 'orig',
          dirty: true,
        },
      ],
      activeTabId: '/x/a',
      mode: 'edit',
    });
    const order: string[] = [];
    let resolve1!: () => void;
    const writeFile = vi
      .fn<(p: string, c: string) => Promise<IpcResult<void>>>()
      .mockImplementationOnce((_p, c) => {
        order.push(`start:${c}`);
        return new Promise((res) => {
          resolve1 = () => {
            order.push(`end:${c}`);
            res(ok(undefined as void));
          };
        });
      })
      .mockImplementationOnce((_p, c) => {
        order.push(`start:${c}`);
        return Promise.resolve(ok(undefined as void));
      });
    const deps = makeDeps({ writeFile });

    // 第一次保存(write1 挂起)
    const p1 = saveFile('/x/a', deps);
    await Promise.resolve();
    // 第二次保存:内容已变 B。串行下 write2 不得在 write1 完成前启动。
    useEditorStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === '/x/a' ? { ...t, content: 'B' } : t)),
    }));
    const p2 = saveFile('/x/a', deps);
    await Promise.resolve();

    expect(order).toEqual(['start:A']); // write2 尚未启动(等 write1)
    resolve1(); // write1 完成 → write2 启动
    await Promise.all([p1, p2]);

    // 严格保序:write1 完整结束后 write2 才开始 → 最后落盘是 B(最新内容)
    expect(order).toEqual(['start:A', 'end:A', 'start:B']);
  });
});
