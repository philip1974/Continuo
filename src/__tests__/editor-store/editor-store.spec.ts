import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTab,
  getEffectiveMode,
  getStateAfterClosingTab,
  getStateAfterClosingTabsOutsideRoot,
  getStateAfterRemovingPath,
  getStateAfterRenamingPath,
  isTabMilkdownUnsafe,
  useEditorStore,
  type EditorTab,
} from '../../stores/editor.store';

const makeTab = (overrides: Partial<EditorTab> = {}): EditorTab => ({
  id: '/x/a.md',
  filePath: '/x/a.md',
  content: 'hello',
  originalContent: 'hello',
  dirty: false,
  ...overrides,
});

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    mode: 'source',
    editorFocusPulse: 0,
    chromeVersion: 0,
  });
});

// ────────────────────────────────────────────────────────────
// createTab
// ────────────────────────────────────────────────────────────

describe('createTab', () => {
  it('有 filePath → id = filePath,originalContent = content,dirty=false', () => {
    const t = createTab('/x/a.md', 'hello');
    expect(t).toEqual({
      id: '/x/a.md',
      filePath: '/x/a.md',
      content: 'hello',
      originalContent: 'hello',
      dirty: false,
      milkdownUnsafe: false, // perf P4:派生缓存,'hello' 无 frontmatter/wiki
    });
  });

  it('perf P4 · createTab 算 milkdownUnsafe 派生缓存', () => {
    // markdown + wiki-link → true
    expect(createTab('/x/a.md', 'see [[Note]]').milkdownUnsafe).toBe(true);
    // markdown + frontmatter → true
    expect(createTab('/x/a.md', '---\nk: v\n---\n').milkdownUnsafe).toBe(true);
    // markdown + 普通正文 → false
    expect(createTab('/x/a.md', 'plain text').milkdownUnsafe).toBe(false);
    // 非 markdown(即便含 wiki 样式)→ false(短路不扫描)
    expect(createTab('/x/a.ts', 'arr[[0]]').milkdownUnsafe).toBe(false);
  });

  it('perf P5 · isTabMilkdownUnsafe 优先读缓存,缺省回退现场计算', () => {
    expect(isTabMilkdownUnsafe(null)).toBe(false);
    // 缓存存在 → 直接读(即便与 content 不一致也信缓存,证明走的是缓存路径)
    const cached = makeTab({
      filePath: '/x/a.md',
      content: 'see [[Note]]', // 实际 unsafe
      milkdownUnsafe: false, // 但缓存说 false
    });
    expect(isTabMilkdownUnsafe(cached)).toBe(false);
    // 缓存缺省(undefined)→ 回退现场算 content
    const uncached = makeTab({
      filePath: '/x/a.md',
      content: 'see [[Note]]',
      milkdownUnsafe: undefined,
    });
    expect(isTabMilkdownUnsafe(uncached)).toBe(true);
  });

  it('无 filePath → id 以 untitled- 开头', () => {
    const t = createTab(null, '');
    expect(t.id.startsWith('untitled-')).toBe(true);
    expect(t.filePath).toBeNull();
  });

  it('两次无 filePath 创建 → id 不重复', () => {
    const t1 = createTab(null, '');
    const t2 = createTab(null, '');
    expect(t1.id).not.toBe(t2.id);
  });
});

// ────────────────────────────────────────────────────────────
// 初态
// ────────────────────────────────────────────────────────────

describe('editor.store · 初态', () => {
  it('tabs 空,activeTabId null,mode source', () => {
    const s = useEditorStore.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
    expect(s.mode).toBe('source');
  });

  it('getEffectiveMode unsafe markdown 强制 source,safe content 返回 state.mode', () => {
    useEditorStore.setState({ mode: 'edit' });
    const unsafe = '---\nid: demo\n---\n# Demo\n';
    const safe = '# Demo\nplain prose\n';

    expect(
      getEffectiveMode(
        makeTab({
          content: unsafe,
          originalContent: unsafe,
        }),
      ),
    ).toBe('source');
    expect(
      getEffectiveMode(
        makeTab({
          content: safe,
          originalContent: safe,
        }),
      ),
    ).toBe('edit');
  });
});

// ────────────────────────────────────────────────────────────
// openTab
// ────────────────────────────────────────────────────────────

describe('openTab', () => {
  it('新 tab → 追加 + 设 activeTabId', () => {
    const t = makeTab({ id: '/a' });
    useEditorStore.getState().openTab(t);
    const s = useEditorStore.getState();
    expect(s.tabs).toEqual([t]);
    expect(s.activeTabId).toBe('/a');
  });

  it('已存在(同 id)→ 不重复追加,只切 activeTabId', () => {
    const t1 = makeTab({ id: '/a' });
    const t2 = makeTab({ id: '/b' });
    const open = useEditorStore.getState().openTab;
    open(t1);
    open(t2);
    open(t1); // 已存在,只切活跃
    const s = useEditorStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs.map((t) => t.id)).toEqual(['/a', '/b']);
    expect(s.activeTabId).toBe('/a');
  });
});

// ────────────────────────────────────────────────────────────
// switchTab
// ────────────────────────────────────────────────────────────

describe('switchTab', () => {
  it('切到已存在 tab', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a' }), makeTab({ id: '/b' })],
      activeTabId: '/a',
    });
    useEditorStore.getState().switchTab('/b');
    expect(useEditorStore.getState().activeTabId).toBe('/b');
  });
});

// ────────────────────────────────────────────────────────────
// editorFocusPulse(issue #22)
//   场景:文档已打开,用户切到 terminal 后又点资源管理器同一文档。
//   activeTabId 不变 → DockShell 若只 deps activeTabId,useEffect 不会
//   再次跑 setActive('editor') → terminal panel 仍盖住。修法:openTab/
//   switchTab 每次都 +1 一个递增 token,DockShell deps 进去。
// ────────────────────────────────────────────────────────────

describe('editorFocusPulse', () => {
  it('初态 = 0', () => {
    expect(useEditorStore.getState().editorFocusPulse).toBe(0);
  });

  it('openTab 新 tab → pulse +1', () => {
    const before = useEditorStore.getState().editorFocusPulse;
    useEditorStore.getState().openTab(makeTab({ id: '/a' }));
    expect(useEditorStore.getState().editorFocusPulse).toBe(before + 1);
  });

  it('openTab 已存在 id → activeTabId 不变也 pulse +1(#22)', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a' })],
      activeTabId: '/a',
      editorFocusPulse: 5,
    });
    useEditorStore.getState().openTab(makeTab({ id: '/a' }));
    expect(useEditorStore.getState().activeTabId).toBe('/a');
    expect(useEditorStore.getState().editorFocusPulse).toBe(6);
  });

  it('switchTab 同 id → activeTabId 不变也 pulse +1(#22)', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a' })],
      activeTabId: '/a',
      editorFocusPulse: 7,
    });
    useEditorStore.getState().switchTab('/a');
    expect(useEditorStore.getState().activeTabId).toBe('/a');
    expect(useEditorStore.getState().editorFocusPulse).toBe(8);
  });

  it('switchTab 异 id → pulse +1', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a' }), makeTab({ id: '/b' })],
      activeTabId: '/a',
      editorFocusPulse: 3,
    });
    useEditorStore.getState().switchTab('/b');
    expect(useEditorStore.getState().editorFocusPulse).toBe(4);
  });
});

// ────────────────────────────────────────────────────────────
// closeTab(委托给 getStateAfterClosingTab 纯函数)
// ────────────────────────────────────────────────────────────

describe('closeTab', () => {
  it('关非活跃 tab → 自身减少,active 不变', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a' }), makeTab({ id: '/b' })],
      activeTabId: '/a',
    });
    useEditorStore.getState().closeTab('/b');
    const s = useEditorStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(['/a']);
    expect(s.activeTabId).toBe('/a');
  });

  it('关活跃 tab,后面有 → 切到下一个', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a' }), makeTab({ id: '/b' }), makeTab({ id: '/c' })],
      activeTabId: '/b',
    });
    useEditorStore.getState().closeTab('/b');
    const s = useEditorStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(['/a', '/c']);
    expect(s.activeTabId).toBe('/c');
  });

  it('关活跃尾部 tab → 切到前一个', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a' }), makeTab({ id: '/b' })],
      activeTabId: '/b',
    });
    useEditorStore.getState().closeTab('/b');
    expect(useEditorStore.getState().activeTabId).toBe('/a');
  });

  it('关最后一个 → activeTabId null', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a' })],
      activeTabId: '/a',
    });
    useEditorStore.getState().closeTab('/a');
    const s = useEditorStore.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
  });

  it('关不存在的 id → 状态不变', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a' })],
      activeTabId: '/a',
    });
    useEditorStore.getState().closeTab('/nope');
    const s = useEditorStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(['/a']);
    expect(s.activeTabId).toBe('/a');
  });
});

// ────────────────────────────────────────────────────────────
// getStateAfterRemovingPath / removePath
// 文件被删除(trash)时,Editor 中对应 tab 应自动关闭。
// 删除文件夹 → 该文件夹下所有打开 tab 都关。
// ────────────────────────────────────────────────────────────

describe('getStateAfterRemovingPath', () => {
  it('没有 tab 匹配 → 状态不变(同引用)', () => {
    const tabs = [makeTab({ id: '/x/a.md' })];
    const r = getStateAfterRemovingPath(tabs, '/x/a.md', '/y/none.md');
    expect(r.tabs).toBe(tabs);
    expect(r.activeTabId).toBe('/x/a.md');
  });

  it('删除单文件,精确匹配 → 关该 tab', () => {
    const tabs = [
      makeTab({ id: '/x/a.md' }),
      makeTab({ id: '/x/b.md', filePath: '/x/b.md' }),
    ];
    const r = getStateAfterRemovingPath(tabs, '/x/a.md', '/x/a.md');
    expect(r.tabs.map((t) => t.id)).toEqual(['/x/b.md']);
    expect(r.activeTabId).toBe('/x/b.md');
  });

  it('删除文件夹 → 关其下所有 tab,不误伤同名前缀文件', () => {
    const tabs = [
      makeTab({ id: '/x/foo/a.md', filePath: '/x/foo/a.md' }),
      makeTab({ id: '/x/foo/sub/b.md', filePath: '/x/foo/sub/b.md' }),
      makeTab({ id: '/x/foobar.md', filePath: '/x/foobar.md' }), // 同前缀 ≠ 子
      makeTab({ id: '/y/c.md', filePath: '/y/c.md' }),
    ];
    const r = getStateAfterRemovingPath(tabs, '/x/foo/a.md', '/x/foo');
    expect(r.tabs.map((t) => t.id)).toEqual(['/x/foobar.md', '/y/c.md']);
  });

  it('active 被关,后面有未关 → 切到下一个', () => {
    const tabs = [
      makeTab({ id: '/a.md', filePath: '/a.md' }),
      makeTab({ id: '/b.md', filePath: '/b.md' }),
      makeTab({ id: '/c.md', filePath: '/c.md' }),
    ];
    const r = getStateAfterRemovingPath(tabs, '/b.md', '/b.md');
    expect(r.activeTabId).toBe('/c.md');
  });

  it('active 是被关的尾部 → 切到前一个', () => {
    const tabs = [
      makeTab({ id: '/a.md', filePath: '/a.md' }),
      makeTab({ id: '/b.md', filePath: '/b.md' }),
    ];
    const r = getStateAfterRemovingPath(tabs, '/b.md', '/b.md');
    expect(r.activeTabId).toBe('/a.md');
  });

  it('删除目录覆盖所有 tab → activeTabId null', () => {
    const tabs = [
      makeTab({ id: '/x/a.md', filePath: '/x/a.md' }),
      makeTab({ id: '/x/b.md', filePath: '/x/b.md' }),
    ];
    const r = getStateAfterRemovingPath(tabs, '/x/a.md', '/x');
    expect(r.tabs).toEqual([]);
    expect(r.activeTabId).toBeNull();
  });

  it('untitled tab(filePath=null)不受任何路径影响', () => {
    const draft = createTab(null, 'd');
    const tabs = [draft, makeTab({ id: '/x/a.md', filePath: '/x/a.md' })];
    const r = getStateAfterRemovingPath(tabs, draft.id, '/x');
    expect(r.tabs.map((t) => t.id)).toEqual([draft.id]);
    expect(r.activeTabId).toBe(draft.id);
  });

  it('Windows 反斜杠路径:删除目录关其下子文件', () => {
    const tabs = [
      makeTab({ id: 'C:\\x\\a.md', filePath: 'C:\\x\\a.md' }),
      makeTab({ id: 'C:\\y\\b.md', filePath: 'C:\\y\\b.md' }),
    ];
    const r = getStateAfterRemovingPath(tabs, 'C:\\x\\a.md', 'C:\\x');
    expect(r.tabs.map((t) => t.id)).toEqual(['C:\\y\\b.md']);
  });
});

// ────────────────────────────────────────────────────────────
// getStateAfterRenamingPath / renamePath
// 文件 / 目录被重命名或移动时,Editor 中对应 tab 的 id+filePath 应跟着改。
// ────────────────────────────────────────────────────────────

describe('getStateAfterRenamingPath', () => {
  it('没有 tab 匹配 → 状态不变(同引用)', () => {
    const tabs = [makeTab({ id: '/x/a.md' })];
    const r = getStateAfterRenamingPath(
      tabs,
      '/x/a.md',
      '/y/none.md',
      '/y/renamed.md',
    );
    expect(r.tabs).toBe(tabs);
    expect(r.activeTabId).toBe('/x/a.md');
  });

  it('精确匹配 → tab.id 与 filePath 同步改成 newPath,dirty 保留', () => {
    const tabs = [
      makeTab({
        id: '/x/a.md',
        filePath: '/x/a.md',
        content: 'edited',
        originalContent: 'old',
        dirty: true,
      }),
    ];
    const r = getStateAfterRenamingPath(tabs, '/x/a.md', '/x/a.md', '/x/b.md');
    expect(r.tabs[0]?.id).toBe('/x/b.md');
    expect(r.tabs[0]?.filePath).toBe('/x/b.md');
    expect(r.tabs[0]?.dirty).toBe(true);
    expect(r.tabs[0]?.content).toBe('edited');
    expect(r.activeTabId).toBe('/x/b.md');
  });

  it('目录 rename → 子文件 tab 前缀 rewrite,sibling 不动', () => {
    const tabs = [
      makeTab({ id: '/x/foo/a.md', filePath: '/x/foo/a.md' }),
      makeTab({ id: '/x/foo/sub/b.md', filePath: '/x/foo/sub/b.md' }),
      makeTab({ id: '/x/foobar.md', filePath: '/x/foobar.md' }), // 同前缀 ≠ 子
      makeTab({ id: '/y/c.md', filePath: '/y/c.md' }),
    ];
    const r = getStateAfterRenamingPath(tabs, '/x/foo/a.md', '/x/foo', '/x/baz');
    expect(r.tabs.map((t) => t.id)).toEqual([
      '/x/baz/a.md',
      '/x/baz/sub/b.md',
      '/x/foobar.md',
      '/y/c.md',
    ]);
  });

  it('untitled tab(filePath=null)不受影响', () => {
    const draft = createTab(null, 'd');
    const tabs = [draft, makeTab({ id: '/x/a.md', filePath: '/x/a.md' })];
    const r = getStateAfterRenamingPath(tabs, draft.id, '/x/a.md', '/x/b.md');
    expect(r.tabs[0]?.id).toBe(draft.id); // untitled 不动
    expect(r.tabs[1]?.id).toBe('/x/b.md');
    expect(r.activeTabId).toBe(draft.id);
  });

  it('active 是被改的目录子文件 → activeTabId 跟到新路径', () => {
    const tabs = [
      makeTab({ id: '/x/foo/a.md', filePath: '/x/foo/a.md' }),
      makeTab({ id: '/x/foo/b.md', filePath: '/x/foo/b.md' }),
    ];
    const r = getStateAfterRenamingPath(
      tabs,
      '/x/foo/a.md',
      '/x/foo',
      '/x/bar',
    );
    expect(r.activeTabId).toBe('/x/bar/a.md');
  });

  it('Windows 反斜杠目录 rename → 子文件 tab rewrite', () => {
    const tabs = [makeTab({ id: 'C:\\x\\a.md', filePath: 'C:\\x\\a.md' })];
    const r = getStateAfterRenamingPath(
      tabs,
      'C:\\x\\a.md',
      'C:\\x',
      'C:\\y',
    );
    expect(r.tabs[0]?.id).toBe('C:\\y\\a.md');
  });
});

describe('renamePath(store method)', () => {
  it('单文件 rename → tab.id 与 activeTabId 同步', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/x/a.md', filePath: '/x/a.md' })],
      activeTabId: '/x/a.md',
    });
    useEditorStore.getState().renamePath('/x/a.md', '/x/b.md');
    const s = useEditorStore.getState();
    expect(s.tabs[0]?.id).toBe('/x/b.md');
    expect(s.activeTabId).toBe('/x/b.md');
  });

  it('目录 move → 子 tab 全部 rewrite', () => {
    useEditorStore.setState({
      tabs: [
        makeTab({ id: '/x/a.md', filePath: '/x/a.md' }),
        makeTab({ id: '/x/sub/b.md', filePath: '/x/sub/b.md' }),
      ],
      activeTabId: '/x/sub/b.md',
    });
    useEditorStore.getState().renamePath('/x', '/y');
    const s = useEditorStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(['/y/a.md', '/y/sub/b.md']);
    expect(s.activeTabId).toBe('/y/sub/b.md');
  });
});

// ────────────────────────────────────────────────────────────
// getStateAfterClosingTabsOutsideRoot / closeTabsOutsideRoot
// 切换工作区 root 时,旧 root 下的 file tab 应自动关闭;
// untitled tab(filePath=null)始终保留。
// ────────────────────────────────────────────────────────────

describe('getStateAfterClosingTabsOutsideRoot', () => {
  it('全部 tab 都在 root 下 → 状态不变(同引用)', () => {
    const tabs = [
      makeTab({ id: '/work/a.md', filePath: '/work/a.md' }),
      makeTab({ id: '/work/sub/b.md', filePath: '/work/sub/b.md' }),
    ];
    const r = getStateAfterClosingTabsOutsideRoot(tabs, '/work/a.md', '/work');
    expect(r.tabs).toBe(tabs);
    expect(r.activeTabId).toBe('/work/a.md');
  });

  it('切换到不重叠 root → 全部 file tab 关闭,untitled 保留', () => {
    const draft = createTab(null, 'd');
    const tabs = [
      makeTab({ id: '/old/a.md', filePath: '/old/a.md' }),
      draft,
      makeTab({ id: '/old/b.md', filePath: '/old/b.md' }),
    ];
    const r = getStateAfterClosingTabsOutsideRoot(tabs, '/old/a.md', '/new');
    expect(r.tabs.map((t) => t.id)).toEqual([draft.id]);
    expect(r.activeTabId).toBe(draft.id);
  });

  it('root=null(关闭文件夹)→ 关所有 file tab,只剩 untitled', () => {
    const draft = createTab(null, 'd');
    const tabs = [
      makeTab({ id: '/old/a.md', filePath: '/old/a.md' }),
      draft,
    ];
    const r = getStateAfterClosingTabsOutsideRoot(tabs, '/old/a.md', null);
    expect(r.tabs.map((t) => t.id)).toEqual([draft.id]);
    expect(r.activeTabId).toBe(draft.id);
  });

  it('root=null + 全是 file tab → 全关,activeTabId null', () => {
    const tabs = [
      makeTab({ id: '/old/a.md', filePath: '/old/a.md' }),
      makeTab({ id: '/old/b.md', filePath: '/old/b.md' }),
    ];
    const r = getStateAfterClosingTabsOutsideRoot(tabs, '/old/a.md', null);
    expect(r.tabs).toEqual([]);
    expect(r.activeTabId).toBeNull();
  });

  it('切换到子目录 → 父目录文件关,子目录文件留', () => {
    const tabs = [
      makeTab({ id: '/work/top.md', filePath: '/work/top.md' }),
      makeTab({ id: '/work/sub/a.md', filePath: '/work/sub/a.md' }),
    ];
    const r = getStateAfterClosingTabsOutsideRoot(
      tabs,
      '/work/top.md',
      '/work/sub',
    );
    expect(r.tabs.map((t) => t.id)).toEqual(['/work/sub/a.md']);
    expect(r.activeTabId).toBe('/work/sub/a.md');
  });

  it('同前缀但非子目录(/x/foo 切到 /x/foobar)→ /x/foo/* 全关', () => {
    const tabs = [
      makeTab({ id: '/x/foo/a.md', filePath: '/x/foo/a.md' }),
      makeTab({ id: '/x/foobar/b.md', filePath: '/x/foobar/b.md' }),
    ];
    const r = getStateAfterClosingTabsOutsideRoot(
      tabs,
      '/x/foo/a.md',
      '/x/foobar',
    );
    expect(r.tabs.map((t) => t.id)).toEqual(['/x/foobar/b.md']);
  });

  it('Windows 反斜杠路径:子目录判定生效', () => {
    const tabs = [
      makeTab({ id: 'C:\\old\\a.md', filePath: 'C:\\old\\a.md' }),
      makeTab({ id: 'C:\\new\\b.md', filePath: 'C:\\new\\b.md' }),
    ];
    const r = getStateAfterClosingTabsOutsideRoot(
      tabs,
      'C:\\old\\a.md',
      'C:\\new',
    );
    expect(r.tabs.map((t) => t.id)).toEqual(['C:\\new\\b.md']);
  });
});

describe('closeTabsOutsideRoot(store method)', () => {
  it('切换 root → outside file tab 关,untitled 留,active 切到剩余', () => {
    const draft = createTab(null, 'd');
    useEditorStore.setState({
      tabs: [
        makeTab({ id: '/old/a.md', filePath: '/old/a.md' }),
        draft,
        makeTab({ id: '/new/b.md', filePath: '/new/b.md' }),
      ],
      activeTabId: '/old/a.md',
    });
    useEditorStore.getState().closeTabsOutsideRoot('/new');
    const s = useEditorStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual([draft.id, '/new/b.md']);
    // active 被关 → 取原序后向第一个 remaining(原 idx 顺序:draft 比
    // /new/b.md 更靠前,所以是 draft;untitled 也算合法 active)
    expect(s.activeTabId).toBe(draft.id);
  });
});

// ────────────────────────────────────────────────────────────
// reloadFromDisk
// 外部修改文件时,非 dirty tab 同步;dirty 跳过避免覆盖用户编辑。
// ────────────────────────────────────────────────────────────

describe('reloadFromDisk', () => {
  it('非 dirty tab → content + originalContent 同步,dirty 仍 false', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/x/a.md', content: 'old', originalContent: 'old', dirty: false })],
      activeTabId: '/x/a.md',
    });
    useEditorStore.getState().reloadFromDisk('/x/a.md', 'new from disk');
    const t = useEditorStore.getState().tabs[0]!;
    expect(t.content).toBe('new from disk');
    expect(t.originalContent).toBe('new from disk');
    expect(t.dirty).toBe(false);
  });

  it('dirty tab → 不动(保护用户改动)', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/x/a.md', content: 'edited', originalContent: 'old', dirty: true })],
      activeTabId: '/x/a.md',
    });
    useEditorStore.getState().reloadFromDisk('/x/a.md', 'new from disk');
    const t = useEditorStore.getState().tabs[0]!;
    expect(t.content).toBe('edited');
    expect(t.originalContent).toBe('old');
    expect(t.dirty).toBe(true);
  });

  it('磁盘内容与 originalContent 一致 → 不重渲(同引用)', () => {
    const before = makeTab({ id: '/x/a.md', content: 'same', originalContent: 'same' });
    useEditorStore.setState({ tabs: [before], activeTabId: '/x/a.md' });
    useEditorStore.getState().reloadFromDisk('/x/a.md', 'same');
    const t = useEditorStore.getState().tabs[0]!;
    expect(t).toBe(before);
  });

  it('id 不存在 → 不变(防异步事件打到已关闭 tab)', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/x/a.md' })],
      activeTabId: '/x/a.md',
    });
    expect(() => useEditorStore.getState().reloadFromDisk('/zombie', 'x')).not.toThrow();
    expect(useEditorStore.getState().tabs[0]?.content).toBe('hello');
  });
});

describe('removePath(store method)', () => {
  it('删除路径 → tabs 与 activeTabId 一并更新', () => {
    useEditorStore.setState({
      tabs: [
        makeTab({ id: '/x/a.md', filePath: '/x/a.md' }),
        makeTab({ id: '/x/b.md', filePath: '/x/b.md' }),
      ],
      activeTabId: '/x/a.md',
    });
    useEditorStore.getState().removePath('/x/a.md');
    const s = useEditorStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(['/x/b.md']);
    expect(s.activeTabId).toBe('/x/b.md');
  });
});

// ────────────────────────────────────────────────────────────
// updateContent
// ────────────────────────────────────────────────────────────

describe('updateContent', () => {
  it('content 与 originalContent 不同 → dirty true', () => {
    useEditorStore.setState({ tabs: [makeTab({ id: '/a' })], activeTabId: '/a' });
    useEditorStore.getState().updateContent('/a', 'changed');
    const tab = useEditorStore.getState().tabs.find((t) => t.id === '/a');
    expect(tab?.content).toBe('changed');
    expect(tab?.dirty).toBe(true);
  });

  it('content 与 originalContent 相同 → dirty false(撤销回原文)', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a', content: 'changed', dirty: true })],
      activeTabId: '/a',
    });
    useEditorStore.getState().updateContent('/a', 'hello'); // = originalContent
    const tab = useEditorStore.getState().tabs.find((t) => t.id === '/a');
    expect(tab?.dirty).toBe(false);
  });

  it('id 不存在 → 状态不变(防异步事件打到已关闭 tab)', () => {
    useEditorStore.setState({ tabs: [makeTab({ id: '/a' })], activeTabId: '/a' });
    useEditorStore.getState().updateContent('/zombie', 'x');
    const tab = useEditorStore.getState().tabs.find((t) => t.id === '/a');
    expect(tab?.content).toBe('hello');
  });

  it('perf P4 · updateContent 重算 milkdownUnsafe 派生缓存(不 stale)', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/x/a.md', milkdownUnsafe: false })],
      activeTabId: '/x/a.md',
    });
    // 输入含 wiki-link → 缓存翻 true
    useEditorStore.getState().updateContent('/x/a.md', 'see [[Note]]');
    expect(
      useEditorStore.getState().tabs.find((t) => t.id === '/x/a.md')
        ?.milkdownUnsafe,
    ).toBe(true);
    // 删回普通正文 → 缓存翻回 false
    useEditorStore.getState().updateContent('/x/a.md', 'plain');
    expect(
      useEditorStore.getState().tabs.find((t) => t.id === '/x/a.md')
        ?.milkdownUnsafe,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// markSaved
// ────────────────────────────────────────────────────────────

describe('markSaved', () => {
  it('originalContent ← content,dirty false', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a', content: 'new', originalContent: 'old', dirty: true })],
      activeTabId: '/a',
    });
    useEditorStore.getState().markSaved('/a');
    const tab = useEditorStore.getState().tabs.find((t) => t.id === '/a');
    expect(tab?.originalContent).toBe('new');
    expect(tab?.dirty).toBe(false);
  });

  it('id 不存在 → 不变', () => {
    useEditorStore.setState({ tabs: [makeTab({ id: '/a' })], activeTabId: '/a' });
    expect(() => useEditorStore.getState().markSaved('/nope')).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────
// setFilePath
// ────────────────────────────────────────────────────────────

describe('setFilePath', () => {
  it('untitled tab 另存为 → id 同步改成 path', () => {
    const draft = createTab(null, 'draft');
    useEditorStore.setState({ tabs: [draft], activeTabId: draft.id });
    useEditorStore.getState().setFilePath(draft.id, '/x/saved.md');
    const s = useEditorStore.getState();
    expect(s.tabs[0]?.id).toBe('/x/saved.md');
    expect(s.tabs[0]?.filePath).toBe('/x/saved.md');
    expect(s.activeTabId).toBe('/x/saved.md');
  });

  it('非活跃 tab 改 path → activeTabId 不变', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a' }), makeTab({ id: '/b' })],
      activeTabId: '/a',
    });
    useEditorStore.getState().setFilePath('/b', '/c');
    const s = useEditorStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(['/a', '/c']);
    expect(s.activeTabId).toBe('/a');
  });
});

// ────────────────────────────────────────────────────────────
// setMode
// ────────────────────────────────────────────────────────────

describe('setMode', () => {
  it('切到 source / preview / edit', () => {
    const set = useEditorStore.getState().setMode;
    set('source');
    expect(useEditorStore.getState().mode).toBe('source');
    set('preview');
    expect(useEditorStore.getState().mode).toBe('preview');
    set('edit');
    expect(useEditorStore.getState().mode).toBe('edit');
  });
});

// ────────────────────────────────────────────────────────────
// getStateAfterClosingTab(纯函数,详细覆盖)
// ────────────────────────────────────────────────────────────

describe('getStateAfterClosingTab', () => {
  const tabs = [
    makeTab({ id: '/a' }),
    makeTab({ id: '/b' }),
    makeTab({ id: '/c' }),
  ];

  it('关 head 活跃 → 切到下一个', () => {
    const r = getStateAfterClosingTab(tabs, '/a', '/a');
    expect(r.tabs.map((t) => t.id)).toEqual(['/b', '/c']);
    expect(r.activeTabId).toBe('/b');
  });

  it('关 mid 活跃 → 切到下一个', () => {
    const r = getStateAfterClosingTab(tabs, '/b', '/b');
    expect(r.tabs.map((t) => t.id)).toEqual(['/a', '/c']);
    expect(r.activeTabId).toBe('/c');
  });

  it('关 tail 活跃 → 切到前一个', () => {
    const r = getStateAfterClosingTab(tabs, '/c', '/c');
    expect(r.tabs.map((t) => t.id)).toEqual(['/a', '/b']);
    expect(r.activeTabId).toBe('/b');
  });

  it('关非活跃 → active 不变', () => {
    const r = getStateAfterClosingTab(tabs, '/a', '/c');
    expect(r.tabs.map((t) => t.id)).toEqual(['/a', '/b']);
    expect(r.activeTabId).toBe('/a');
  });

  it('唯一 tab 关闭 → active null', () => {
    const r = getStateAfterClosingTab([makeTab({ id: '/x' })], '/x', '/x');
    expect(r.tabs).toEqual([]);
    expect(r.activeTabId).toBeNull();
  });

  it('关不存在的 id → 状态不变', () => {
    const r = getStateAfterClosingTab(tabs, '/a', '/missing');
    expect(r.tabs).toBe(tabs);
    expect(r.activeTabId).toBe('/a');
  });
});

// ────────────────────────────────────────────────────────────
// perf P12 — chromeVersion 仅在 chrome 真变化时递增
// ────────────────────────────────────────────────────────────

describe('perf P12 — chromeVersion bump 契约', () => {
  const ver = () => useEditorStore.getState().chromeVersion;

  it('updateContent 在已脏 tab 持续输入(dirty 恒 true)→ 不 bump', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a.md', content: 'x', originalContent: 'orig', dirty: true })],
      activeTabId: '/a.md',
      chromeVersion: 5,
    });
    useEditorStore.getState().updateContent('/a.md', 'xy');
    useEditorStore.getState().updateContent('/a.md', 'xyz');
    expect(ver()).toBe(5); // dirty 恒 true → chrome 不变
  });

  it('updateContent 翻转 dirty(clean→dirty / dirty→clean)→ bump', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a.md', content: 'orig', originalContent: 'orig', dirty: false })],
      activeTabId: '/a.md',
      chromeVersion: 0,
    });
    useEditorStore.getState().updateContent('/a.md', 'edited'); // clean→dirty
    expect(ver()).toBe(1);
    useEditorStore.getState().updateContent('/a.md', 'orig'); // dirty→clean
    expect(ver()).toBe(2);
  });

  it('openTab 新增 → bump;openTab 已存在(仅切 active)→ 不 bump', () => {
    useEditorStore.setState({ tabs: [], activeTabId: null, chromeVersion: 0 });
    const tab = makeTab({ id: '/a.md' });
    useEditorStore.getState().openTab(tab);
    expect(ver()).toBe(1);
    useEditorStore.getState().openTab(tab); // 已存在
    expect(ver()).toBe(1);
  });

  it('setFilePath → bump;closeTab(真删)→ bump;关不存在 → 不 bump', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a.md' }), makeTab({ id: '/b.md' })],
      activeTabId: '/a.md',
      chromeVersion: 0,
    });
    useEditorStore.getState().setFilePath('/a.md', '/a2.md');
    expect(ver()).toBe(1);
    useEditorStore.getState().closeTab('/missing'); // no-op
    expect(ver()).toBe(1);
    useEditorStore.getState().closeTab('/b.md'); // 真删
    expect(ver()).toBe(2);
  });

  it('markSaved 改 dirty → bump;reloadFromDisk / switchTab → 不 bump', () => {
    useEditorStore.setState({
      tabs: [makeTab({ id: '/a.md', content: 'edited', originalContent: 'orig', dirty: true })],
      activeTabId: '/a.md',
      chromeVersion: 0,
    });
    useEditorStore.getState().markSaved('/a.md', 'edited'); // dirty true→false
    expect(ver()).toBe(1);
    // reloadFromDisk(非脏 tab,只换 content)→ chrome 不变
    useEditorStore.getState().reloadFromDisk('/a.md', 'external');
    expect(ver()).toBe(1);
    useEditorStore.getState().switchTab('/a.md');
    expect(ver()).toBe(1);
  });
});
