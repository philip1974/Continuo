// BDD:编辑器 tab 管理的 store 行为 —— 移动 tab、固定 tab、组 MRU。见同目录 README。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTab,
  editorGroupIdsOf,
  groupActiveTabIdOf,
  groupPreviewTabIdOf,
  groupStickyTabsOf,
  groupTabsOf,
  useEditorStore,
} from '../../stores/editor.store';
import { tabCloseTargets } from '../../lib/tab-close-targets';
import { clearRecentlyClosedEditors, recentlyClosedEditorPaths } from '../../panels/Editor/recently-closed-editors';

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';
const D = '/w/d.ts';

const st = () => useEditorStore.getState();

function reset(): void {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    groupMru: ['editor'],
    tabMru: new Map(),
    previewTabs: new Map(),
    stickyTabs: new Map(),
    viewRefs: new Map(),
  });
  clearRecentlyClosedEditors();
}

function open(path: string, opts?: Parameters<ReturnType<typeof st>['openTab']>[1]): void {
  st().openTab(createTab(path, path), opts);
}

function ids(groupId: string): string[] {
  return groupTabsOf(st(), groupId).map((t) => t.id);
}

/** editor: A B C;editor:2: D(活动组)。 */
function twoGroups(): void {
  open(A);
  open(B);
  open(C);
  st().splitGroup('editor', 'editor:2', null);
  open(D);
}

beforeEach(reset);

describe('移动 tab 到别的组(moveTab 跨组)', () => {
  it('从源组移除、加入目标组末尾并在其中激活;目标组成为活动组;文档仍只有一份(脏内容跟随)', () => {
    twoGroups();
    st().updateContent(B, 'edited');
    expect(st().moveTab(B, 'editor', 'editor:2')).toBe(true);
    expect(ids('editor')).toEqual([A, C]);
    expect(ids('editor:2')).toEqual([D, B]);
    expect(st().activeGroupId).toBe('editor:2');
    expect(st().activeTabId).toBe(B);
    expect(st().tabs.filter((t) => t.id === B)).toHaveLength(1);
    expect(st().tabs.find((t) => t.id === B)).toMatchObject({ content: 'edited', dirty: true });
  });

  it('源组被移空 → 关闭(closeEmptyGroups),不进最近关闭栈', () => {
    open(A);
    st().splitGroup('editor', 'editor:2', null);
    open(B);
    st().moveTab(B, 'editor:2', 'editor');
    expect(editorGroupIdsOf(st())).toEqual(['editor']);
    expect(ids('editor')).toEqual([A, B]);
    expect(st().activeTabId).toBe(B);
    expect(recentlyClosedEditorPaths()).toEqual([]);
  });

  it('目标组已有该文件 → 用目标组那个(不重复),源组关掉自己的', () => {
    twoGroups();
    open(B, { groupId: 'editor:2' });
    st().switchTab(D, { groupId: 'editor:2' });
    st().moveTab(B, 'editor', 'editor:2');
    expect(ids('editor')).toEqual([A, C]);
    expect(ids('editor:2')).toEqual([D, B]);
    expect(groupActiveTabIdOf(st(), 'editor:2')).toBe(B);
  });

  it('预览 tab 移过去后常驻(VSCode 跨组移动以 pinned 打开)', () => {
    open(A);
    open(B, { preview: true });
    st().splitGroup('editor', 'editor:2', A);
    expect(groupPreviewTabIdOf(st(), 'editor')).toBe(B);
    st().moveTab(B, 'editor', 'editor:2');
    expect(groupPreviewTabIdOf(st(), 'editor')).toBeUndefined();
    expect(groupPreviewTabIdOf(st(), 'editor:2')).toBeUndefined();
  });

  it('固定的 tab 移过去仍固定,排在目标组固定区末尾', () => {
    twoGroups();
    open(A, { groupId: 'editor:2' });
    st().pinEditor(A, 'editor:2');
    st().pinEditor(C, 'editor');
    st().moveTab(C, 'editor', 'editor:2');
    expect(ids('editor:2')).toEqual([A, C, D]);
    expect(groupStickyTabsOf(st(), 'editor:2')).toEqual([A, C]);
    expect(groupStickyTabsOf(st(), 'editor')).toEqual([]);
  });

  it('不在源组 / 目标组不存在 → 不动', () => {
    twoGroups();
    expect(st().moveTab(D, 'editor', 'editor:2')).toBe(false);
    expect(st().moveTab(A, 'editor', 'editor:9')).toBe(false);
    expect(ids('editor')).toEqual([A, B, C]);
  });
});

describe('组内移动(moveTab 同组)', () => {
  it('移到 index(越界收进范围),活动 tab 不变', () => {
    open(A);
    open(B);
    open(C);
    st().moveTab(A, 'editor', 'editor', 1);
    expect(ids('editor')).toEqual([B, A, C]);
    st().moveTab(A, 'editor', 'editor', 99);
    expect(ids('editor')).toEqual([B, C, A]);
    expect(st().activeTabId).toBe(C);
    expect(st().moveTab(A, 'editor', 'editor', 2)).toBe(false);
  });

  it('越过固定区边界随之固定 / 取消固定(VSCode EditorGroupModel.moveEditor)', () => {
    open(A);
    open(B);
    open(C);
    st().pinEditor(A);
    st().moveTab(A, 'editor', 'editor', 1);
    expect(ids('editor')).toEqual([B, A, C]);
    expect(groupStickyTabsOf(st(), 'editor')).toEqual([]);
    st().pinEditor(B);
    st().moveTab(C, 'editor', 'editor', 0);
    expect(ids('editor')).toEqual([C, B, A]);
    expect(groupStickyTabsOf(st(), 'editor')).toEqual([C, B]);
  });
});

describe('固定 tab(pinEditor / unpinEditor)', () => {
  it('固定:移到固定区末尾;取消:移到第一个非固定位置', () => {
    open(A);
    open(B);
    open(C);
    st().pinEditor(C);
    expect(ids('editor')).toEqual([C, A, B]);
    st().pinEditor(B);
    expect(ids('editor')).toEqual([C, B, A]);
    expect(groupStickyTabsOf(st(), 'editor')).toEqual([C, B]);
    st().unpinEditor(C);
    expect(ids('editor')).toEqual([B, C, A]);
    expect(groupStickyTabsOf(st(), 'editor')).toEqual([B]);
  });

  it('固定预览 tab 同时转常驻(VSCode doStick 先 pin);keepTab 只转常驻不固定', () => {
    open(A);
    open(B, { preview: true });
    st().keepTab(B);
    expect(groupPreviewTabIdOf(st(), 'editor')).toBeUndefined();
    expect(groupStickyTabsOf(st(), 'editor')).toEqual([]);
    open(C, { preview: true });
    st().pinEditor(C);
    expect(groupPreviewTabIdOf(st(), 'editor')).toBeUndefined();
    expect(groupStickyTabsOf(st(), 'editor')).toEqual([C]);
  });

  it('新打开的 tab 不进固定区(插入位置在固定区之后)', () => {
    open(A);
    open(B);
    st().pinEditor(A);
    st().pinEditor(B);
    open(C, { index: 0 });
    expect(ids('editor')).toEqual([A, B, C]);
  });

  it('多组:各组各自的固定状态;拆分出的副本不固定', () => {
    open(A);
    st().pinEditor(A);
    st().splitGroup('editor', 'editor:2', A);
    expect(groupStickyTabsOf(st(), 'editor')).toEqual([A]);
    expect(groupStickyTabsOf(st(), 'editor:2')).toEqual([]);
  });

  it('关掉固定的 tab → 固定记录随之移除;改名 / 另存为后仍固定', () => {
    open(A);
    open(B);
    st().pinEditor(A);
    st().renamePath(A, '/w/a2.ts');
    expect(groupStickyTabsOf(st(), 'editor')).toEqual(['/w/a2.ts']);
    st().retargetTab('/w/a2.ts', '/w/a3.ts');
    expect(groupStickyTabsOf(st(), 'editor')).toEqual(['/w/a3.ts']);
    st().closeTab('/w/a3.ts');
    expect(groupStickyTabsOf(st(), 'editor')).toEqual([]);
  });

  it('关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭跳过固定的;「关闭」照常关它', () => {
    const tabs = [
      { id: A, sticky: true },
      { id: B, sticky: true, dirty: false },
      { id: C },
      { id: D, dirty: true },
    ];
    expect(tabCloseTargets(tabs, C, 'others')).toEqual([D]);
    expect(tabCloseTargets(tabs, A, 'right')).toEqual([C, D]);
    expect(tabCloseTargets(tabs, A, 'saved')).toEqual([C]);
    expect(tabCloseTargets(tabs, A, 'all')).toEqual([C, D]);
    expect(tabCloseTargets(tabs, A, 'close')).toEqual([A]);
  });
});

describe('组 MRU:活动组关闭后落到最近使用的组', () => {
  /** 三组:editor(A)、editor:2(B)、editor:3(C);依次激活 editor:3 → editor → editor:2。 */
  function threeGroups(): void {
    open(A);
    st().splitGroup('editor', 'editor:2', null);
    open(B);
    st().splitGroup('editor:2', 'editor:3', null);
    open(C);
    st().setActiveGroup('editor');
    st().setActiveGroup('editor:2');
  }

  it('groupMru 随活动组维护(活动组居首)', () => {
    threeGroups();
    expect(st().groupMru).toEqual(['editor:2', 'editor', 'editor:3']);
  });

  it('关掉活动组的最后一个 tab → 活动组落到 MRU 的下一个(不是左邻)', () => {
    threeGroups();
    st().setActiveGroup('editor:3');
    st().setActiveGroup('editor');
    st().setActiveGroup('editor:2');
    // MRU:editor:2 → editor → editor:3;左邻也是 editor —— 换一个顺序让两者不同
    st().setActiveGroup('editor:3');
    st().setActiveGroup('editor:2');
    expect(st().groupMru.slice(0, 2)).toEqual(['editor:2', 'editor:3']);
    st().closeTab(B, 'editor:2');
    expect(st().activeGroupId).toBe('editor:3');
    expect(st().activeTabId).toBe(C);
  });

  it('dock 面板被关(removeGroup)→ 活动组与移走的脏文档都落到 MRU 组', () => {
    threeGroups();
    st().setActiveGroup('editor:3');
    st().setActiveGroup('editor:2');
    st().updateContent(B, 'dirty');
    st().removeGroup('editor:2', 'dirty');
    expect(st().activeGroupId).toBe('editor:3');
    expect(ids('editor:3')).toEqual([C, B]);
  });

  it("removeGroup keep 'none'(已确认保存 / 不保存):脏文档也关闭", () => {
    threeGroups();
    st().updateContent(B, 'dirty');
    st().removeGroup('editor:2', 'none');
    expect(st().tabs.map((t) => t.id)).toEqual([A, C]);
  });
});
