// @vitest-environment jsdom
// BDD:预览编辑器的 store 语义(每组至多一个预览 tab、原位替换、转常驻)。见同目录 README。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTab,
  groupActiveTabIdOf,
  groupPreviewTabIdOf,
  groupTabsOf,
  useEditorStore,
  type EditorFocusOpts,
} from '../../stores/editor.store';
import { clearRecentlyClosedEditors, recentlyClosedEditorPaths } from '../../panels/Editor/recently-closed-editors';

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';
const D = '/w/d.ts';

function reset(): void {
  clearRecentlyClosedEditors();
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    tabMru: new Map(),
    previewTabs: new Map(),
    mode: 'source',
    viewRefs: new Map(),
  });
}

beforeEach(reset);

const st = () => useEditorStore.getState();
const open = (path: string, opts?: EditorFocusOpts) => st().openTab(createTab(path, path), opts);
const ids = (groupId = 'editor') => groupTabsOf(st(), groupId).map((t) => t.id);
const previewOf = (groupId = 'editor') => groupPreviewTabIdOf(st(), groupId);

describe('单组', () => {
  it('以预览方式打开 → 成为预览 tab;再以预览方式打开别的文件 → 原位替换,不新增 tab', () => {
    open(A);
    open(B, { preview: true });
    open(C);
    expect(previewOf()).toBe(B);
    open(D, { preview: true });
    expect(ids()).toEqual([A, D, C]);
    expect(st().activeTabId).toBe(D);
    expect(previewOf()).toBe(D);
  });

  it('被替换的预览 tab 不进「重新打开已关闭的编辑器」栈', () => {
    open(A, { preview: true });
    open(B, { preview: true });
    expect(ids()).toEqual([B]);
    expect(recentlyClosedEditorPaths()).toEqual([]);
  });

  it('常驻打开(缺省)不替换预览 tab', () => {
    open(A, { preview: true });
    open(B);
    expect(ids()).toEqual([A, B]);
    expect(previewOf()).toBe(A);
  });

  it('已开着的文件以预览方式再打开 → 只切换,常驻的仍常驻', () => {
    open(A);
    open(B, { preview: true });
    open(A, { preview: true });
    expect(ids()).toEqual([A, B]);
    expect(previewOf()).toBe(B);
    st().switchTab(B, { preview: true });
    expect(previewOf()).toBe(B);
  });

  it('preview:false 打开已是预览的 tab → 转常驻(资源管理器双击 / ⌘P)', () => {
    open(A, { preview: true });
    st().switchTab(A, { preview: false });
    expect(previewOf()).toBeUndefined();
    open(B, { preview: true });
    expect(ids()).toEqual([A, B]);
  });

  it('切换 tab(缺省选项)不改变预览状态', () => {
    open(A, { preview: true });
    open(B);
    st().switchTab(A);
    expect(previewOf()).toBe(A);
  });

  it('编辑(变脏)→ 转常驻;之后的预览打开新增 tab,不替换它', () => {
    open(A, { preview: true });
    st().updateContent(A, 'edited');
    expect(previewOf()).toBeUndefined();
    open(B, { preview: true });
    expect(ids()).toEqual([A, B]);
    expect(st().tabs.find((t) => t.id === A)?.content).toBe('edited');
  });

  it('保存 → 转常驻', () => {
    open(A, { preview: true });
    st().markSaved(A, A, 1);
    expect(previewOf()).toBeUndefined();
  });

  it('keepTab(双击 tab / 保留编辑器)→ 转常驻;对常驻 tab 是 no-op', () => {
    open(A, { preview: true });
    open(B);
    const before = st().chromeVersion;
    st().keepTab(B, 'editor');
    expect(st().chromeVersion).toBe(before);
    st().keepTab(A, 'editor');
    expect(previewOf()).toBeUndefined();
    expect(st().chromeVersion).toBe(before + 1);
  });

  it('关闭预览 tab → 预览记录随之清除', () => {
    open(A, { preview: true });
    st().closeTab(A);
    open(B);
    expect(previewOf()).toBeUndefined();
  });

  it('后台加入(activate:false)时不替换正在显示的预览 tab,新 tab 常驻', () => {
    open(A, { preview: true });
    open(B, { preview: true, activate: false, requestFocus: false });
    expect(ids()).toEqual([A, B]);
    expect(st().activeTabId).toBe(A);
    expect(previewOf()).toBe(A);
  });

  it('后台加入时预览 tab 不在显示 → 照常原位替换,活动 tab 不变', () => {
    open(A, { preview: true });
    open(C);
    open(B, { preview: true, activate: false, requestFocus: false });
    expect(ids()).toEqual([B, C]);
    expect(st().activeTabId).toBe(C);
    expect(previewOf()).toBe(B);
  });

  it('改名 / 移动后常驻', () => {
    open(A, { preview: true });
    st().renamePath(A, '/w/a2.ts');
    expect(ids()).toEqual(['/w/a2.ts']);
    expect(previewOf()).toBeUndefined();
  });
});

describe('多组', () => {
  function twoGroups(): void {
    open(A);
    expect(st().splitGroup('editor', 'editor:2', A)).toBe(true);
  }

  it('预览状态按组:各组至多一个预览 tab,互不替换', () => {
    twoGroups();
    open(B, { preview: true, groupId: 'editor' });
    open(C, { preview: true, groupId: 'editor:2' });
    expect(previewOf('editor')).toBe(B);
    expect(previewOf('editor:2')).toBe(C);
    open(D, { preview: true, groupId: 'editor:2' });
    expect(ids('editor')).toEqual([A, B]);
    expect(ids('editor:2')).toEqual([A, D]);
    expect(st().tabs.map((t) => t.id).sort()).toEqual([A, B, D].sort());
  });

  it('被替换的文档还在别的组 → 只从本组移除,文档保留', () => {
    twoGroups();
    open(B, { preview: true, groupId: 'editor' });
    st().switchTab(B, { groupId: 'editor:2', preview: true });
    expect(previewOf('editor:2')).toBe(B);
    open(C, { preview: true, groupId: 'editor:2' });
    expect(ids('editor:2')).toEqual([A, C]);
    expect(ids('editor')).toEqual([A, B]);
    expect(st().tabs.some((t) => t.id === B)).toBe(true);
  });

  it('拆分出来的副本在新组里常驻,源组的预览状态不变', () => {
    open(A, { preview: true });
    expect(st().splitGroup('editor', 'editor:2', A)).toBe(true);
    expect(previewOf('editor')).toBe(A);
    expect(previewOf('editor:2')).toBeUndefined();
    open(B, { preview: true, groupId: 'editor:2' });
    expect(ids('editor:2')).toEqual([A, B]);
  });

  it('文档在别的组打开、以预览方式在本组打开 → 替换本组的预览 tab', () => {
    twoGroups();
    open(B, { groupId: 'editor' });
    open(C, { preview: true, groupId: 'editor:2' });
    st().switchTab(B, { groupId: 'editor:2', preview: true });
    expect(ids('editor:2')).toEqual([A, B]);
    expect(groupActiveTabIdOf(st(), 'editor:2')).toBe(B);
    expect(previewOf('editor:2')).toBe(B);
    expect(st().tabs.some((t) => t.id === C)).toBe(false);
  });

  it('保存 → 各组都转常驻', () => {
    twoGroups();
    open(B, { preview: true, groupId: 'editor' });
    st().switchTab(B, { groupId: 'editor:2', preview: true });
    st().markSaved(B, B, 2);
    expect(previewOf('editor')).toBeUndefined();
    expect(previewOf('editor:2')).toBeUndefined();
  });

  it('关闭组 → 移到相邻组的 tab 常驻', () => {
    twoGroups();
    open(B, { preview: true, groupId: 'editor:2' });
    st().removeGroup('editor:2', 'all');
    expect(ids('editor')).toEqual([A, B]);
    expect(previewOf('editor')).toBeUndefined();
  });
});
