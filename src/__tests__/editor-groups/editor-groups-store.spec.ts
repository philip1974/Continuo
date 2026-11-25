// BDD:编辑器组模型(对齐 VSCode editor groups)。见同目录 README。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTab,
  groupActiveTabIdOf,
  groupTabsOf,
  editorGroupIdsOf,
  isTabOpenInOtherGroup,
  useEditorStore,
} from '../../stores/editor.store';

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';

function reset(): void {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
}

function open(path: string, content = path): void {
  useEditorStore.getState().openTab(createTab(path, content));
}

function ids(groupId: string): string[] {
  return groupTabsOf(useEditorStore.getState(), groupId).map((t) => t.id);
}

beforeEach(reset);

describe('单组模式与历史一致', () => {
  it('默认只有一个组 editor,组的 tab 列表就是 tabs、活动 tab 就是 activeTabId', () => {
    open(A);
    open(B);
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor']);
    expect(ids('editor')).toEqual([A, B]);
    expect(groupActiveTabIdOf(s, 'editor')).toBe(B);
  });

  it('直接 setState tabs / activeTabId(既有代码与测试)仍被视为唯一组的内容', () => {
    useEditorStore.setState({ tabs: [createTab(A, 'x'), createTab(B, 'y')], activeTabId: A });
    expect(ids('editor')).toEqual([A, B]);
    expect(groupActiveTabIdOf(useEditorStore.getState(), 'editor')).toBe(A);
  });
});

describe('拆分', () => {
  it('splitGroup:新组只含源组的活动文件并成为活动组;文档仍只有一份', () => {
    open(A);
    open(B);
    expect(useEditorStore.getState().splitGroup('editor', 'editor:2')).toBe(true);
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor', 'editor:2']);
    expect(ids('editor')).toEqual([A, B]);
    expect(ids('editor:2')).toEqual([B]);
    expect(s.activeGroupId).toBe('editor:2');
    expect(s.activeTabId).toBe(B);
    expect(s.tabs.map((t) => t.id)).toEqual([A, B]);
  });

  it('可指定拆分的文件(tab 右键「向右拆分」)', () => {
    open(A);
    open(B);
    useEditorStore.getState().splitGroup('editor', 'editor:2', A);
    expect(ids('editor:2')).toEqual([A]);
    expect(useEditorStore.getState().activeTabId).toBe(A);
  });

  it('源组没有活动文件 / 新 id 已存在 → 不拆分', () => {
    expect(useEditorStore.getState().splitGroup('editor', 'editor:2')).toBe(false);
    open(A);
    useEditorStore.getState().splitGroup('editor', 'editor:2');
    expect(useEditorStore.getState().splitGroup('editor', 'editor:2')).toBe(false);
    expect(editorGroupIdsOf(useEditorStore.getState())).toEqual(['editor', 'editor:2']);
  });

  it('新组插在源组之后', () => {
    open(A);
    useEditorStore.getState().splitGroup('editor', 'editor:2');
    useEditorStore.getState().splitGroup('editor', 'editor:3');
    expect(editorGroupIdsOf(useEditorStore.getState())).toEqual(['editor', 'editor:3', 'editor:2']);
  });
});

describe('打开 / 切换落到活动组', () => {
  beforeEach(() => {
    open(A);
    useEditorStore.getState().splitGroup('editor', 'editor:2');
  });

  it('新文件只进活动组', () => {
    open(B);
    expect(ids('editor:2')).toEqual([A, B]);
    expect(ids('editor')).toEqual([A]);
    expect(useEditorStore.getState().activeTabId).toBe(B);
  });

  it('文件已在别的组打开 → 在活动组也打开(共享同一文档)', () => {
    useEditorStore.getState().setActiveGroup('editor');
    open(B);
    useEditorStore.getState().setActiveGroup('editor:2');
    useEditorStore.getState().switchTab(B);
    expect(ids('editor:2')).toEqual([A, B]);
    expect(useEditorStore.getState().tabs.filter((t) => t.id === B)).toHaveLength(1);
  });

  it('switchTab 指定组 → 该组成为活动组', () => {
    useEditorStore.getState().switchTab(A, { groupId: 'editor' });
    const s = useEditorStore.getState();
    expect(s.activeGroupId).toBe('editor');
    expect(s.activeTabId).toBe(A);
  });

  it('setActiveGroup:activeTabId 镜像活动组的活动文件', () => {
    open(B);
    useEditorStore.getState().setActiveGroup('editor');
    expect(useEditorStore.getState().activeTabId).toBe(A);
    useEditorStore.getState().setActiveGroup('editor:2');
    expect(useEditorStore.getState().activeTabId).toBe(B);
  });
});

describe('共享文档', () => {
  it('一处编辑,两组看到同一内容与脏状态', () => {
    open(A, 'v1');
    useEditorStore.getState().splitGroup('editor', 'editor:2');
    useEditorStore.getState().updateContent(A, 'v2');
    const s = useEditorStore.getState();
    expect(groupTabsOf(s, 'editor')[0]).toBe(groupTabsOf(s, 'editor:2')[0]);
    expect(groupTabsOf(s, 'editor')[0]!.content).toBe('v2');
    expect(groupTabsOf(s, 'editor:2')[0]!.dirty).toBe(true);
  });

  it('isTabOpenInOtherGroup', () => {
    open(A);
    open(B);
    useEditorStore.getState().splitGroup('editor', 'editor:2');
    const s = useEditorStore.getState();
    expect(isTabOpenInOtherGroup(s, B, 'editor:2')).toBe(true);
    expect(isTabOpenInOtherGroup(s, A, 'editor')).toBe(false);
  });
});

describe('关闭', () => {
  beforeEach(() => {
    open(A);
    open(B);
    useEditorStore.getState().splitGroup('editor', 'editor:2');
    open(C);
  });

  it('关闭只在本组移除;文档仍在别的组 → 保留', () => {
    useEditorStore.getState().closeTab(B, 'editor:2');
    expect(ids('editor:2')).toEqual([C]);
    expect(ids('editor')).toEqual([A, B]);
    expect(useEditorStore.getState().tabs.map((t) => t.id)).toContain(B);
  });

  it('文档不在其它组 → 关闭即移除文档', () => {
    useEditorStore.getState().closeTab(C, 'editor:2');
    expect(useEditorStore.getState().tabs.map((t) => t.id)).toEqual([A, B]);
  });

  it('缺省关闭活动组的 tab', () => {
    useEditorStore.getState().closeTab(C);
    expect(ids('editor:2')).toEqual([B]);
  });

  it('关掉组内最后一个 → 关闭该组,活动组落到相邻组;只剩一组回到单组模式', () => {
    useEditorStore.getState().closeTab(B, 'editor:2');
    useEditorStore.getState().closeTab(C, 'editor:2');
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor']);
    expect(s.activeGroupId).toBe('editor');
    expect(s.activeTabId).toBe(B);
    expect(s.tabs.map((t) => t.id)).toEqual([A, B]);
  });

  it('剩下的组不是 editor 时,单组模式的 tabs 按该组顺序', () => {
    useEditorStore.getState().closeTab(A, 'editor');
    useEditorStore.getState().closeTab(B, 'editor');
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor:2']);
    expect(s.tabs.map((t) => t.id)).toEqual([B, C]);
    expect(s.activeTabId).toBe(C);
  });

  it('最后一个组关掉最后一个 tab → 保留为空编辑区', () => {
    useEditorStore.getState().removeGroup('editor:2', 'all');
    for (const id of [A, B, C]) useEditorStore.getState().closeTab(id);
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor']);
    expect(s.tabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
  });
});

describe('删除 / 改名作用于所有组', () => {
  beforeEach(() => {
    open(A);
    open(B);
    useEditorStore.getState().splitGroup('editor', 'editor:2');
  });

  it('删除文件:每组都关掉它;变空的组关闭', () => {
    useEditorStore.getState().removePaths([B]);
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor']);
    expect(s.tabs.map((t) => t.id)).toEqual([A]);
    expect(s.activeTabId).toBe(A);
  });

  it('改名:每组的 tab id 跟随', () => {
    useEditorStore.getState().renamePath(B, '/w/b2.ts');
    expect(ids('editor')).toEqual([A, '/w/b2.ts']);
    expect(ids('editor:2')).toEqual(['/w/b2.ts']);
    expect(useEditorStore.getState().activeTabId).toBe('/w/b2.ts');
  });
});

describe('移除组(dock 面板被关)', () => {
  it("keep 'dirty':只在本组的干净文档关闭,脏文档移到相邻组", () => {
    open(A);
    useEditorStore.getState().splitGroup('editor', 'editor:2');
    open(B);
    open(C);
    useEditorStore.getState().updateContent(C, 'changed');
    useEditorStore.getState().removeGroup('editor:2', 'dirty');
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor']);
    expect(s.tabs.map((t) => t.id)).toEqual([A, C]);
    expect(s.activeGroupId).toBe('editor');
  });

  it('唯一的组不移除(文档保留,与历史一致)', () => {
    open(A);
    useEditorStore.getState().removeGroup('editor', 'dirty');
    expect(useEditorStore.getState().tabs.map((t) => t.id)).toEqual([A]);
  });
});

describe('ensureGroup / restoreGroups', () => {
  it('ensureGroup 为恢复出的组面板建空组,不改活动组', () => {
    open(A);
    useEditorStore.getState().ensureGroup('editor:2');
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor', 'editor:2']);
    expect(ids('editor')).toEqual([A]);
    expect(ids('editor:2')).toEqual([]);
    expect(s.activeGroupId).toBe('editor');
  });

  it('restoreGroups:按布局分配已打开的文档;未分配的进活动组;不存在的文件与空组丢弃', () => {
    open(A);
    open(B);
    open(C);
    useEditorStore.getState().restoreGroups(
      [
        { id: 'editor', tabIds: [A, '/w/gone.ts'], activeTabId: A },
        { id: 'editor:2', tabIds: [B], activeTabId: B },
        { id: 'editor:3', tabIds: ['/w/gone.ts'], activeTabId: null },
      ],
      'editor:2',
    );
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor', 'editor:2']);
    expect(ids('editor')).toEqual([A]);
    expect(ids('editor:2')).toEqual([B, C]);
    expect(s.activeGroupId).toBe('editor:2');
    expect(s.activeTabId).toBe(B);
  });
});

describe('空组', () => {
  it('splitGroup(…, null):新建空组并成为活动组(⌘2 聚焦尚不存在的第二组)', () => {
    open(A);
    expect(useEditorStore.getState().splitGroup('editor', 'editor:2', null)).toBe(true);
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor', 'editor:2']);
    expect(ids('editor:2')).toEqual([]);
    expect(s.activeGroupId).toBe('editor:2');
    expect(s.activeTabId).toBeNull();
    // 在空组里打开文件 → 落在这里
    open(B);
    expect(ids('editor:2')).toEqual([B]);
  });

  it('已关闭的组(面板还在退出动画里)读不到别组的内容', () => {
    open(A);
    useEditorStore.getState().splitGroup('editor', 'editor:2');
    useEditorStore.getState().closeTab(A, 'editor:2');
    const s = useEditorStore.getState();
    expect(groupTabsOf(s, 'editor:2')).toEqual([]);
    expect(groupActiveTabIdOf(s, 'editor:2')).toBeNull();
  });
});

describe('同一文档的多个视图登记', () => {
  it('后挂载的视图卸载后,viewRefs 回指仍挂着的另一组视图', () => {
    open(A);
    const v1 = {} as never;
    const v2 = {} as never;
    useEditorStore.getState().registerView(A, v1);
    useEditorStore.getState().registerView(A, v2);
    expect(useEditorStore.getState().viewRefs.get(A)).toBe(v2);
    useEditorStore.getState().unregisterView(A, v2);
    expect(useEditorStore.getState().viewRefs.get(A)).toBe(v1);
    useEditorStore.getState().unregisterView(A, v1);
    expect(useEditorStore.getState().viewRefs.has(A)).toBe(false);
  });
});
