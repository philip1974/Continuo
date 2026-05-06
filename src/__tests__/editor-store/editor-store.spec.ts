import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTab,
  getStateAfterClosingTab,
  getStateAfterRemovingPath,
  getStateAfterRenamingPath,
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
    mode: 'edit',
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
    });
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
  it('tabs 空,activeTabId null,mode edit', () => {
    const s = useEditorStore.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
    expect(s.mode).toBe('edit');
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
