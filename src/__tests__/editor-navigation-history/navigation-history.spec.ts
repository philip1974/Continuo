// @vitest-environment jsdom
// BDD: editor-navigation-history —— 后退 / 前进:命令与键位、记录时机、执行、路径变更、工作区切换。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';
import { cursorSyntaxLeft, cursorSyntaxRight, defaultKeymap, selectSyntaxLeft, selectSyntaxRight } from '@codemirror/commands';

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), notifyFailure: vi.fn() }));
vi.mock('../../panels/Editor/editor-file-deps', () => ({
  editorFileDeps: { fs: { readFile: mocks.readFile, writeFile: vi.fn() } },
}));
vi.mock('../../notifications/notify-thrown-error', async (orig) => ({
  ...(await orig<object>()),
  notifyFailure: mocks.notifyFailure,
}));

import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { createTab, groupActiveTabIdOf, useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { editorCommandSpecs } from '@/panels/Editor/editor-commands';
import {
  NAVIGATE_BACK_COMMAND_ID,
  NAVIGATE_FORWARD_COMMAND_ID,
  navigateBack,
  navigateForward,
  navigationStack,
  resetNavigationHistory,
} from '@/panels/Editor/navigation-history';
import { navigationHistoryExtension } from '@/panels/Editor/codemirror-navigation-history';
import { endRecentEditorNavigation, openRecentlyUsedEditorInGroup } from '@/panels/Editor/editor-recent-cycle';
import { codeEditorBasicSetup, withoutAltArrowSyntaxKeys } from '@/panels/Editor/codemirror-basic-setup';
import { POPOUT_HOTKEY_COMMAND_IDS, winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { isTerminalKeptHotkey, terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const BACK = NAVIGATE_BACK_COMMAND_ID;
const FORWARD = NAVIGATE_FORWARD_COMMAND_ID;
const [A, B, C] = ['/w/a.ts', '/w/b.ts', '/w/c.ts'] as const;
const DOC = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n');
const st = () => useEditorStore.getState();
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
const open = (p: string, groupId?: string) =>
  st().openTab(createTab(p, DOC), groupId === undefined ? undefined : { groupId });
/** 栈内容:`路径@行`(只记文件的不带行)。 */
const entries = (): string[] =>
  navigationStack().entries.map((e) => `${e.path}${e.selection ? `@${e.selection.line}` : ''}`);
const active = (): string | null => groupActiveTabIdOf(st(), st().activeGroupId);

const views: { tab: string; view: EditorView }[] = [];
/** 挂一个带导航记录扩展的视图(光标在第 line 行),登记进 store。 */
function mountView(tab: string, line = 1, groupId = 'editor'): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc: DOC,
    selection: EditorSelection.cursor(EditorState.create({ doc: DOC }).doc.line(line).from),
    extensions: navigationHistoryExtension(tab, groupId),
  });
  const view = new EditorView({ state, parent });
  st().registerView(tab, view, groupId);
  views.push({ tab, view });
  return view;
}
const moveTo = (view: EditorView, line: number) =>
  view.dispatch({ selection: { anchor: view.state.doc.line(line).from }, userEvent: 'select' });
const cursorLine = (view: EditorView) => view.state.doc.lineAt(view.state.selection.main.head).number;

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  mocks.readFile.mockReset();
  mocks.notifyFailure.mockReset();
  useWorkspaceStore.setState({ root: null });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
  resetNavigationHistory();
});

afterEach(() => {
  for (const { tab, view } of views.splice(0)) {
    st().unregisterView(tab, view);
    view.dom.remove();
    view.destroy();
  }
});

describe('命令与键位', () => {
  it('id 同 VSCode;mac ⌃- / ⌃⇧-,Windows / Linux Alt+← / Alt+→', () => {
    const mac = editorCommandSpecs('mac');
    expect(mac.find((s) => s.id === BACK)?.hotkey).toBe('ctrl+-');
    expect(mac.find((s) => s.id === FORWARD)?.hotkey).toBe('ctrl+shift+-');
    const other = editorCommandSpecs('other');
    expect(other.find((s) => s.id === BACK)?.hotkey).toBe('alt+left');
    expect(other.find((s) => s.id === FORWARD)?.hotkey).toBe('alt+right');
  });

  it('经命令注册表注册,三语标题', () => {
    for (const [id, title] of [
      [BACK, ['Go Back', '返回']],
      [FORWARD, ['Go Forward', '前进']],
    ] as const) {
      const spec = coApp.commands.get(id);
      expect(spec).toBeDefined();
      const k = spec!.titleKey as keyof typeof en;
      expect(en[k]).toBe(title[0]);
      expect(zh[k]).toBe(title[1]);
      expect(ko[k]).toBeTruthy();
    }
  });

  // 注册表按运行平台注册键位:按平台取 spec 做分发判定
  it('分发:mac ⌃- / ⌃⇧-(⇧ 时 e.key 为 _ 也认);⌘- 不是', () => {
    const all = editorCommandSpecs('mac');
    expect(winningCommandFor(key({ key: '-', code: 'Minus', ctrlKey: true }), all, 'mac', {})?.id).toBe(BACK);
    expect(winningCommandFor(key({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true }), all, 'mac', {})?.id).toBe(
      FORWARD,
    );
    expect(winningCommandFor(key({ key: '-', code: 'Minus', metaKey: true }), all, 'mac', {})?.id).not.toBe(BACK);
  });

  it('分发:Windows / Linux Alt+← / Alt+→', () => {
    const all = editorCommandSpecs('other');
    expect(winningCommandFor(key({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), all, 'other', {})?.id).toBe(BACK);
    expect(winningCommandFor(key({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }), all, 'other', {})?.id).toBe(
      FORWARD,
    );
  });

  it('终端里不让出(照常进 shell,VSCode commandsToSkipShell 不含),也不冒泡到全局分发(焦点留在终端)', () => {
    const registry = (platform: 'mac' | 'other') => ({ getAll: () => editorCommandSpecs(platform) });
    const macBack = key({ key: '-', code: 'Minus', ctrlKey: true });
    const otherBack = key({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
    expect(terminalYieldedCommandId(macBack, 'mac', {}, registry('mac'))).toBeNull();
    expect(terminalYieldedCommandId(otherBack, 'other', {}, registry('other'))).toBeNull();
    // 第四十轮审计:xterm 对 ⌃- 什么都不发,事件冒泡到全局执行了后退 → 终端截住冒泡
    expect(isTerminalKeptHotkey(macBack, 'mac', {}, registry('mac'))).toBe(true);
    expect(isTerminalKeptHotkey(otherBack, 'other', {}, registry('other'))).toBe(true);
    expect(isTerminalKeptHotkey(key({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true }), 'mac', {}, registry('mac'))).toBe(
      true,
    );
    // 用户改绑到带 ⌘ 的键 → 照常交给工作台(VSCode:Meta 键跳过 shell)
    expect(isTerminalKeptHotkey(key({ key: '[', code: 'BracketLeft', metaKey: true }), 'mac', { [BACK]: 'mod+[' }, registry('mac'))).toBe(
      false,
    );
  });

  it('popout 子窗里也分发', () => {
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(BACK)).toBe(true);
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(FORWARD)).toBe(true);
  });

  it('CodeMirror:Windows / Linux 去掉 Alt+← / Alt+→ 按语法跳,mac 的 ⌃← / ⌃→ 保留;按语法选择(⇧)让给扩展 / 收缩选区', () => {
    const out = withoutAltArrowSyntaxKeys(defaultKeymap);
    const syntax = out.filter((b) => b.run === cursorSyntaxLeft || b.run === cursorSyntaxRight);
    expect(syntax.every((b) => b.key === undefined)).toBe(true);
    expect(syntax.map((b) => b.mac)).toEqual(['Ctrl-ArrowLeft', 'Ctrl-ArrowRight']);
    // ⇧Alt+← / ⇧Alt+→(mac ⌃⇧← / ⌃⇧→)是 VSCode 的收缩 / 扩展选区(见 src/__tests__/editor-language-commands/)
    expect(syntax.some((b) => b.shift !== undefined)).toBe(false);
    expect(out.some((b) => b.run === selectSyntaxLeft || b.run === selectSyntaxRight)).toBe(false);
  });

  it('CodeMirror 编辑区里按 Alt+← / Alt+→ / ⇧Alt+← 不被 CodeMirror 吞掉(jsdom 非 mac;⇧Alt+← 经注册表分发为收缩选区)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: 'foo(bar)\n', selection: EditorSelection.cursor(8), extensions: codeEditorBasicSetup }),
      parent,
    });
    const press = (init: KeyboardEventInit): boolean => {
      const e = key(init);
      view.contentDOM.dispatchEvent(e);
      return e.defaultPrevented;
    };
    try {
      expect(press({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, altKey: true })).toBe(false);
      expect(press({ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, altKey: true })).toBe(false);
      expect(press({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, altKey: true, shiftKey: true })).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe('换编辑器时记录', () => {
  it('打开 / 切换文件各记一条', () => {
    open(A);
    open(B);
    st().switchTab(A);
    expect(entries()).toEqual([A, B, A]);
  });

  it('⌃Tab 按住修饰键连按:途经的编辑器不各记一条,只记最后落到的', () => {
    open(A);
    open(B);
    open(C);
    expect(entries()).toEqual([A, B, C]);
    openRecentlyUsedEditorInGroup(1); // → B
    openRecentlyUsedEditorInGroup(1); // → A
    endRecentEditorNavigation();
    expect(active()).toBe(A);
    expect(entries()).toEqual([A, B, C, A]);
    openRecentlyUsedEditorInGroup(1); // 新一次导航 → C
    openRecentlyUsedEditorInGroup(1); // → B
    openRecentlyUsedEditorInGroup(1); // → A(与前一条同一位置 → 合并)
    endRecentEditorNavigation();
    expect(entries()).toEqual([A, B, C, A]);
  });

  it('会话恢复(requestFocus:false 的程序化打开)不记', () => {
    st().openTab(createTab(A, DOC), { requestFocus: false });
    st().openTab(createTab(B, DOC), { requestFocus: false });
    expect(entries()).toEqual([]);
  });

  it('关掉当前 tab、相邻 tab 接替 → 记(VSCode 同)', () => {
    open(A);
    open(B);
    st().closeTab(B);
    expect(entries()).toEqual([A, B, A]);
  });

  it('切到另一个编辑器组 → 记(组 + 文件是一条)', () => {
    useEditorStore.setState({
      tabs: [createTab(A, DOC), createTab(B, DOC)],
      groups: [
        { id: 'editor', tabIds: [A], activeTabId: A },
        { id: 'editor:2', tabIds: [B], activeTabId: B },
      ],
      activeGroupId: 'editor',
      activeTabId: A,
    });
    st().setActiveGroup('editor:2');
    st().setActiveGroup('editor');
    expect(navigationStack().entries.map((e) => `${e.groupId}:${e.path}`)).toEqual(['editor:2:/w/b.ts', 'editor:/w/a.ts']);
  });
});

describe('同一文件内的光标', () => {
  it('跳 ≥ 10 行新记一条;小幅移动与打字只更新当前这条', () => {
    open(A);
    const view = mountView(A, 1);
    moveTo(view, 5);
    expect(entries()).toEqual([`${A}@5`]);
    moveTo(view, 300);
    expect(entries()).toEqual([`${A}@5`, `${A}@300`]);
    view.dispatch(view.state.replaceSelection('typed'));
    moveTo(view, 303);
    expect(entries()).toEqual([`${A}@5`, `${A}@303`]);
  });

  it('当前这条还没有光标(刚换过来)→ 先按移动前的光标补上,再记跳转目标', () => {
    open(A);
    const view = mountView(A, 20);
    moveTo(view, 300);
    expect(entries()).toEqual([`${A}@20`, `${A}@300`]);
  });

  it('不是活动编辑器的视图(另一组 / 后台)的选区变化不记', () => {
    open(A);
    open(B);
    const view = mountView(A, 1);
    moveTo(view, 300);
    expect(entries()).toEqual([A, B]);
  });
});

describe('执行后退 / 前进', () => {
  it('回到原文件的原光标(居中),再前进;执行本身不记录', async () => {
    open(A);
    const a = mountView(A, 1);
    moveTo(a, 200);
    open(B);
    moveTo(a, 1); // 后台视图被别处移动(不是活动编辑器,不记)
    expect(entries()).toEqual([`${A}@1`, `${A}@200`, B]);
    await navigateBack();
    expect(active()).toBe(A);
    expect(cursorLine(a)).toBe(200);
    expect(entries()).toEqual([`${A}@1`, `${A}@200`, B]);
    expect(navigationStack().index).toBe(1);
    await navigateForward();
    expect(active()).toBe(B);
    expect(navigationStack().index).toBe(2);
  });

  it('同一文件内跳远后后退 → 回到原行', async () => {
    open(A);
    const a = mountView(A, 40);
    moveTo(a, 41);
    moveTo(a, 350);
    await navigateBack();
    expect(cursorLine(a)).toBe(41);
    await navigateForward();
    expect(cursorLine(a)).toBe(350);
  });

  it('后退后产生新导航 → 前进部分清掉;栈到头 no-op', async () => {
    open(A);
    open(B);
    await navigateBack();
    expect(active()).toBe(A);
    open(C);
    expect(entries()).toEqual([A, C]);
    await navigateForward();
    expect(active()).toBe(C);
    await navigateBack();
    await navigateBack();
    expect(active()).toBe(A);
  });

  it('文件没开着 → 读盘打开;读不到 → 提示,不切换', async () => {
    open(A);
    open(B);
    st().closeTab(A);
    mocks.readFile.mockResolvedValueOnce({ ok: true, data: DOC });
    await navigateBack();
    expect(mocks.readFile).toHaveBeenCalledWith(A);
    expect(active()).toBe(A);

    open(C);
    st().closeTab(A);
    // 栈:A, B, A, C;此刻活动 C。后退到 A(已关、读不到)
    mocks.readFile.mockResolvedValueOnce({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' });
    await navigateBack();
    expect(mocks.notifyFailure).toHaveBeenCalled();
    expect(active()).toBe(C);
  });

  it('原编辑器组已不在 → 在触发窗口的编辑器组打开', async () => {
    useEditorStore.setState({
      tabs: [createTab(A, DOC), createTab(B, DOC), createTab(C, DOC)],
      groups: [
        { id: 'editor', tabIds: [B], activeTabId: B },
        { id: 'editor:2', tabIds: [C], activeTabId: C },
        { id: 'editor:3', tabIds: [A], activeTabId: A },
      ],
      activeGroupId: 'editor:3',
      activeTabId: A,
    });
    st().setActiveGroup('editor');
    expect(navigationStack().entries.map((e) => `${e.groupId}:${e.path}`)).toEqual([`editor:3:${A}`, `editor:${B}`]);
    st().removeGroup('editor:3', 'all'); // A 移到相邻的 editor:2
    await navigateBack();
    expect(st().activeGroupId).toBe('editor');
    expect(active()).toBe(A);
  });
});

describe('文件删除 / 移动、工作区切换', () => {
  it('删除:剔除其下条目;移动 / 改名:路径改写', () => {
    open(A);
    open('/w/d/x.ts');
    open(B);
    st().removePaths(['/w/d']);
    expect(entries()).toEqual([A, B]);
    st().renamePath(B, '/w/b2.ts');
    expect(entries()).toEqual([A, '/w/b2.ts']);
  });

  it('切换工作区根:不在新根下的条目剔除', () => {
    open('/x/c.ts');
    open(A);
    useWorkspaceStore.setState({ root: '/w' });
    expect(entries()).toEqual([A]);
  });
});
