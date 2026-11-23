import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  findEditorFileTabById,
  findEditorFileTabByPath,
} from '../../panels/Editor/editor-tab-lookup';
import {
  openFileByPath,
  saveFile,
  type EditorFileDeps,
} from '../../panels/Editor/editor-file-actions';
import {
  createTab,
  useEditorStore,
} from '../../stores/editor.store';
import type { IpcResult } from '../../lib/fs/types';
import {
  _resetSavedDiskStatsForTest,
  getSavedDiskStat,
} from '../../panels/Editor/saved-disk-stat';

const ok = <T,>(data: T): IpcResult<T> => ({ ok: true, data });
const fail = (code: string, message = code): IpcResult<never> => ({
  ok: false,
  code,
  message,
});

const makeDeps = (overrides: Partial<EditorFileDeps['fs']> = {}): EditorFileDeps => ({
  fs: {
    // 默认磁盘 = 已打开 tab 的 originalContent(未被外部修改),saveFile 的冲突检测不触发;
    // 未打开的路径读到 ''。外部修改冲突见 49-polish-bugfixes/save-external-change-conflict。
    readFile: vi.fn(async (p: string) =>
      ok(findEditorFileTabByPath(useEditorStore.getState().tabs, p)?.originalContent ?? ''),
    ),
    writeFile: vi.fn(async () => ok(undefined)),
    ...overrides,
  },
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

  it('symlink 文件:readFile 带 realPath → tab 记下真实目标(供外部同步匹配),id/filePath 仍为打开路径', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => ({ ok: true as const, data: 'agents', realPath: '/x/AGENTS.md' })),
    });
    await openFileByPath('/x/CLAUDE.md', deps);
    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      id: '/x/CLAUDE.md',
      filePath: '/x/CLAUDE.md',
      realPath: '/x/AGENTS.md',
    });
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

  // 跨平台(复查 P1):去重用平台感知 pathEquals。Windows 上同一文件不同大小写打开
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

  // 最新请求胜出:快速连续打开时,最终激活的是用户最后点的文件,而不是读盘最后完成的文件。
  // 读盘慢的旧请求完成后仍加入 tab,但只在后台加入,不抢激活、不抢焦点。
  it('大文件读盘在途时打开小文件 → 最终激活小文件,大文件 tab 仍后台加入', async () => {
    let resolveBig!: (v: IpcResult<string>) => void;
    const readFile = vi
      .fn<(p: string) => Promise<IpcResult<string>>>()
      .mockImplementationOnce(() => new Promise((res) => (resolveBig = res)))
      .mockImplementationOnce(async () => ok('small'));
    const deps = makeDeps({ readFile });

    const pBig = openFileByPath('/x/big.md', deps);
    await openFileByPath('/x/small.md', deps);
    expect(useEditorStore.getState().activeTabId).toBe('/x/small.md');
    const pulse = useEditorStore.getState().editorFocusPulse;

    resolveBig(ok('big'));
    await pBig;

    const s = useEditorStore.getState();
    expect(s.activeTabId).toBe('/x/small.md');
    expect(s.tabs.map((t) => t.id)).toEqual(['/x/small.md', '/x/big.md']);
    expect(s.editorFocusPulse).toBe(pulse); // 后台加入不抢焦点
  });

  it('大文件读盘在途时切到已开 tab → 最终激活已开 tab,大文件 tab 仍后台加入', async () => {
    useEditorStore.getState().openTab(createTab('/x/open.md', 'o'));
    useEditorStore.getState().openTab(createTab('/x/other.md', 'p'));
    let resolveBig!: (v: IpcResult<string>) => void;
    const readFile = vi
      .fn<(p: string) => Promise<IpcResult<string>>>()
      .mockImplementationOnce(() => new Promise((res) => (resolveBig = res)));
    const deps = makeDeps({ readFile });

    const pBig = openFileByPath('/x/big.md', deps);
    await openFileByPath('/x/open.md', deps); // 已开 → 只 switchTab,但也算最新请求
    resolveBig(ok('big'));
    await pBig;

    const s = useEditorStore.getState();
    expect(s.activeTabId).toBe('/x/open.md');
    expect(s.tabs.map((t) => t.id)).toContain('/x/big.md');
  });

  it('先发的请求先读完(按序完成)→ 最终激活后发的文件', async () => {
    let resolveA!: (v: IpcResult<string>) => void;
    let resolveB!: (v: IpcResult<string>) => void;
    const readFile = vi
      .fn<(p: string) => Promise<IpcResult<string>>>()
      .mockImplementationOnce(() => new Promise((res) => (resolveA = res)))
      .mockImplementationOnce(() => new Promise((res) => (resolveB = res)));
    const deps = makeDeps({ readFile });

    const pA = openFileByPath('/x/a.md', deps);
    const pB = openFileByPath('/x/b.md', deps);
    resolveA(ok('a'));
    await pA;
    resolveB(ok('b'));
    await pB;

    expect(useEditorStore.getState().activeTabId).toBe('/x/b.md');
  });

  // 用户激活不只来自 openFileByPath:tab 栏点击直接调 store.switchTab,同样是更晚的用户意图。
  it('读盘在途时在 tab 栏切到已开 tab → 最终激活该 tab,读完的文件后台加入且不抢焦点', async () => {
    useEditorStore.getState().openTab(createTab('/x/a.md', 'a'));
    useEditorStore.getState().openTab(createTab('/x/b.md', 'b'));
    let resolveBig!: (v: IpcResult<string>) => void;
    const readFile = vi
      .fn<(p: string) => Promise<IpcResult<string>>>()
      .mockImplementationOnce(() => new Promise((res) => (resolveBig = res)));
    const deps = makeDeps({ readFile });

    const pBig = openFileByPath('/x/big.md', deps);
    useEditorStore.getState().switchTab('/x/a.md'); // EditorHeader onSelect
    const pulse = useEditorStore.getState().editorFocusPulse;
    resolveBig(ok('big'));
    await pBig;

    const s = useEditorStore.getState();
    expect(s.activeTabId).toBe('/x/a.md');
    expect(s.tabs.map((t) => t.id)).toContain('/x/big.md');
    expect(s.editorFocusPulse).toBe(pulse);
  });

  // 会话恢复(requestFocus:false)不是用户意图:恢复期间插入 / 切换不应让用户刚点的文件失去激活。
  it('读盘在途时会话恢复 switchTab(requestFocus:false) → 读完仍激活用户请求的文件', async () => {
    useEditorStore.getState().openTab(createTab('/x/a.md', 'a'));
    useEditorStore.getState().openTab(createTab('/x/b.md', 'b'));
    let resolveBig!: (v: IpcResult<string>) => void;
    const readFile = vi
      .fn<(p: string) => Promise<IpcResult<string>>>()
      .mockImplementationOnce(() => new Promise((res) => (resolveBig = res)));
    const deps = makeDeps({ readFile });

    const pBig = openFileByPath('/x/big.md', deps);
    useEditorStore.getState().switchTab('/x/a.md', { requestFocus: false });
    resolveBig(ok('big'));
    await pBig;

    expect(useEditorStore.getState().activeTabId).toBe('/x/big.md');
  });

  it('读盘在途时关闭当前活动 tab(非激活选择)→ 读完仍激活用户请求的文件', async () => {
    useEditorStore.getState().openTab(createTab('/x/a.md', 'a'));
    useEditorStore.getState().openTab(createTab('/x/b.md', 'b'));
    let resolveBig!: (v: IpcResult<string>) => void;
    const readFile = vi
      .fn<(p: string) => Promise<IpcResult<string>>>()
      .mockImplementationOnce(() => new Promise((res) => (resolveBig = res)));
    const deps = makeDeps({ readFile });

    const pBig = openFileByPath('/x/big.md', deps);
    useEditorStore.getState().closeTab('/x/b.md');
    resolveBig(ok('big'));
    await pBig;

    expect(useEditorStore.getState().activeTabId).toBe('/x/big.md');
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
    const writeFile = vi.fn(async () => ok(undefined));
    const deps = makeDeps({ writeFile });
    const r = await saveFile('/x/a.md', deps);
    expect(r.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/x/a.md', 'new content');
    const tab = useEditorStore.getState().tabs[0];
    expect(tab?.dirty).toBe(false);
    expect(tab?.originalContent).toBe('new content');
  });

  // 性能(保存回声识别):写成功带回的 { mtimeMs, size } 按 tab 路径记录,并与 tab 上的运行时保存代际 savedGen
  // 绑定(记录不持有写入内容,避免大文件内容常驻 renderer);未知则清旧记录。
  it('成功且 writeFile 带回 stat → 按 tab 路径记录 stat + 保存代际(不存内容),tab.savedGen 同值;未带 → 清除旧记录', async () => {
    _resetSavedDiskStatsForTest();
    const dirtyTab = (content: string) => ({
      id: '/x/a.md',
      filePath: '/x/a.md',
      content,
      originalContent: 'old',
      dirty: true,
    });
    useEditorStore.setState({ tabs: [dirtyTab('v1')], activeTabId: '/x/a.md', mode: 'edit' });
    const writeFile = vi
      .fn<(p: string, c: string) => Promise<IpcResult<{ mtimeMs: number; size: number; ino: number } | undefined>>>()
      .mockResolvedValueOnce(ok({ mtimeMs: 42.5, size: 2, ino: 9 }))
      .mockResolvedValueOnce(ok(undefined));
    await saveFile('/x/a.md', makeDeps({ writeFile }));
    const rec = getSavedDiskStat('/x/a.md');
    expect(rec).toMatchObject({ mtimeMs: 42.5, size: 2, ino: 9 });
    expect(rec).not.toHaveProperty('content');
    expect(typeof rec?.gen).toBe('number');
    expect(useEditorStore.getState().tabs[0]?.savedGen).toBe(rec?.gen);

    useEditorStore.setState({ tabs: [dirtyTab('v2')], activeTabId: '/x/a.md', mode: 'edit' });
    await saveFile('/x/a.md', makeDeps({ writeFile }));
    expect(getSavedDiskStat('/x/a.md')).toBeUndefined();
  });

  it('同一 tab 两次保存 → 代际递增,tab.savedGen 跟随最新记录', async () => {
    _resetSavedDiskStatsForTest();
    useEditorStore.setState({
      tabs: [{ id: '/x/a.md', filePath: '/x/a.md', content: 'v1', originalContent: 'old', dirty: true }],
      activeTabId: '/x/a.md',
      mode: 'edit',
    });
    const writeFile = vi.fn(async () => ok({ mtimeMs: 1, size: 2, ino: 3 }));
    await saveFile('/x/a.md', makeDeps({ writeFile }));
    const g1 = getSavedDiskStat('/x/a.md')?.gen;
    useEditorStore.getState().updateContent('/x/a.md', 'v2');
    await saveFile('/x/a.md', makeDeps({ writeFile }));
    const g2 = getSavedDiskStat('/x/a.md')?.gen;
    expect(g2).not.toBe(g1);
    expect(useEditorStore.getState().tabs[0]?.savedGen).toBe(g2);
  });

  // 不长期持有:tab 关闭 / 删除 / 改名后,对应保存记录随 chromeVersion 变化被清理。
  describe('保存记录随 tab 生命周期清理', () => {
    const saveOne = async (path: string): Promise<void> => {
      useEditorStore.setState({
        tabs: [
          ...useEditorStore.getState().tabs,
          { id: path, filePath: path, content: 'v1', originalContent: 'old', dirty: true },
        ],
        activeTabId: path,
        mode: 'edit',
      });
      await saveFile(path, makeDeps({ writeFile: vi.fn(async () => ok({ mtimeMs: 1, size: 2, ino: 3 })) }));
      expect(getSavedDiskStat(path)).toBeDefined();
    };
    beforeEach(() => _resetSavedDiskStatsForTest());

    it('closeTab → 记录清理', async () => {
      await saveOne('/x/a.md');
      await saveOne('/x/b.md');
      useEditorStore.getState().closeTab('/x/a.md');
      expect(getSavedDiskStat('/x/a.md')).toBeUndefined();
      expect(getSavedDiskStat('/x/b.md')).toBeDefined();
    });

    it('removePaths → 记录清理', async () => {
      await saveOne('/x/a.md');
      useEditorStore.getState().removePaths(['/x/a.md']);
      expect(getSavedDiskStat('/x/a.md')).toBeUndefined();
    });

    it('renamePath → 旧路径记录清理', async () => {
      await saveOne('/x/a.md');
      useEditorStore.getState().renamePath('/x/a.md', '/x/c.md');
      expect(getSavedDiskStat('/x/a.md')).toBeUndefined();
      expect(getSavedDiskStat('/x/c.md')).toBeUndefined();
    });

    it('外部 reload 换了内容(savedGen 失效)→ 下次 chrome 变化时记录清理', async () => {
      await saveOne('/x/a.md');
      useEditorStore.getState().reloadFromDisk('/x/a.md', 'external');
      expect(useEditorStore.getState().tabs[0]?.savedGen).toBeUndefined();
      await saveOne('/x/b.md');
      expect(getSavedDiskStat('/x/a.md')).toBeUndefined();
      expect(getSavedDiskStat('/x/b.md')).toBeDefined();
    });

    it('写盘期间 tab 被关闭 → 不留下孤儿记录(下次 chrome 变化时清理)', async () => {
      useEditorStore.setState({
        tabs: [{ id: '/x/a.md', filePath: '/x/a.md', content: 'v1', originalContent: 'old', dirty: true }],
        activeTabId: '/x/a.md',
        mode: 'edit',
      });
      const writeFile = vi.fn(async () => {
        useEditorStore.getState().closeTab('/x/a.md');
        return ok({ mtimeMs: 1, size: 2, ino: 3 });
      });
      await saveFile('/x/a.md', makeDeps({ writeFile }));
      await saveOne('/x/b.md');
      expect(getSavedDiskStat('/x/a.md')).toBeUndefined();
    });
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
      .fn<(p: string, c: string) => Promise<IpcResult<undefined>>>()
      .mockImplementationOnce((_p, c) => {
        order.push(`start:${c}`);
        return new Promise((res) => {
          resolve1 = () => {
            order.push(`end:${c}`);
            res(ok(undefined));
          };
        });
      })
      .mockImplementationOnce((_p, c) => {
        order.push(`start:${c}`);
        return Promise.resolve(ok(undefined));
      });
    const deps = makeDeps({ writeFile });

    // 第一次保存(write1 挂起)
    const p1 = saveFile('/x/a', deps);
    // 写盘前有一次冲突检测读盘(P2-BL),等 write1 真正启动再改内容。
    await vi.waitFor(() => expect(order).toEqual(['start:A']));
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
