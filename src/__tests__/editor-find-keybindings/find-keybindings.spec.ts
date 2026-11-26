// @vitest-environment jsdom
// BDD: editor-find-keybindings 第 1–4 条 —— 查找 / 替换 / 查找下一个·上一个经命令注册表分发(when: editorFocus,查找面板里同样生效),
// 改键后旧键失效、新键生效且不被 CodeMirror 抢走;Markdown 代码块保留 CodeMirror 自带键。见同目录 README。
// jsdom 平台非 mac(useCommandHotkeys 按 Ctrl 分发);mac 键位用 winningCommandFor('mac') 判定。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';
import { findNext, findPrevious, openSearchPanel, searchPanelOpen } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { basicSetup } from 'codemirror';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { useCommandHotkeys, winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { codeEditorBasicSetup } from '@/panels/Editor/codemirror-basic-setup';
import { codeEditorTextCommands } from '@/panels/Editor/codemirror-text-commands';
import { codeEditorFind, openReplacePanel } from '@/panels/Editor/codemirror-find';
import { markdownCodeBlockTheme } from '@/panels/Editor/code-editor-theme';
import { editorTextCommandSpecs } from '@/panels/Editor/editor-text-commands';

const views: EditorView[] = [];
const DOC = 'foo\nbar foo\nbaz foo\n';

/** CodeEditor 同款扩展(basicSetup 改写 + 命令登记 / 标记 + 查找补强)。 */
function mountEditor(doc = DOC, tabId = '/w/a.js'): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [codeEditorBasicSetup, codeEditorTextCommands(), codeEditorFind, javascript()] }),
    parent,
  });
  useEditorStore.getState().openTab(createTab(tabId, doc), { groupId: 'editor' });
  useEditorStore.getState().registerView(tabId, view, 'editor');
  views.push(view);
  return view;
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

const searchField = (v: EditorView) => v.dom.querySelector<HTMLInputElement>('.cm-search [main-field]');
const replaceField = (v: EditorView) => v.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]');
const head = (v: EditorView) => v.state.selection.main.head;

const CTRL_F: KeyboardEventInit = { key: 'f', code: 'KeyF', keyCode: 70, ctrlKey: true };
const CTRL_H: KeyboardEventInit = { key: 'h', code: 'KeyH', keyCode: 72, ctrlKey: true };
const CTRL_SHIFT_G: KeyboardEventInit = { key: 'G', code: 'KeyG', keyCode: 71, ctrlKey: true, shiftKey: true };
const F3: KeyboardEventInit = { key: 'F3', code: 'F3', keyCode: 114 };
const SHIFT_F3: KeyboardEventInit = { ...F3, shiftKey: true };

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  useKeybindingsStore.setState({ overrides: {} });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
});

afterEach(() => {
  cleanup();
  for (const v of views.splice(0)) v.destroy();
  document.body.innerHTML = '';
});

describe('命令表与上下文条件', () => {
  it('查找 / 替换 / 查找下一个·上一个:VSCode 默认键,when: editorFocus;mac 另有 F3 / ⇧F3', () => {
    const mac = editorTextCommandSpecs('mac');
    const other = editorTextCommandSpecs('other');
    const by = (specs: typeof mac, id: string) => specs.find((s) => s.id === id);
    expect(by(mac, 'editor.action.nextMatchFindAction')).toMatchObject({
      title: 'Find Next',
      hotkey: 'mod+g',
      secondaryHotkeys: ['f3'],
      when: 'editorFocus',
    });
    expect(by(mac, 'editor.action.previousMatchFindAction')).toMatchObject({
      title: 'Find Previous',
      hotkey: 'mod+shift+g',
      secondaryHotkeys: ['shift+f3'],
      when: 'editorFocus',
    });
    expect(by(other, 'editor.action.nextMatchFindAction')).toMatchObject({ hotkey: 'f3' });
    expect(by(other, 'editor.action.nextMatchFindAction')?.secondaryHotkeys).toBeUndefined();
    expect(by(other, 'editor.action.previousMatchFindAction')).toMatchObject({ hotkey: 'shift+f3' });
    expect(by(mac, 'actions.find')?.when).toBe('editorFocus');
    expect(by(other, 'editor.action.startFindReplaceAction')).toMatchObject({ hotkey: 'ctrl+h', when: 'editorFocus' });
  });

  it('mac:编辑器正文与查找面板里 ⌘F / ⌘G / F3 / ⇧⌘G / ⌥⌘F 胜出为查找类命令;终端里 ⌘F 仍是终端查找', () => {
    const v = mountEditor();
    openSearchPanel(v);
    // 注册表按 jsdom 平台(Windows / Linux)登记;mac 判定换上 mac 版编辑器命令(附加默认键 F3 只在 mac)
    const macSpecs = editorTextCommandSpecs('mac');
    const all = [...coApp.commands.getAll().filter((c) => !macSpecs.some((m) => m.id === c.id)), ...macSpecs];
    for (const target of [v.contentDOM, searchField(v)!]) {
      const win = (init: KeyboardEventInit) => winningCommandFor(press(target, init), all, 'mac', {})?.id;
      expect(win({ key: 'f', code: 'KeyF', metaKey: true })).toBe('actions.find');
      expect(win({ key: 'g', code: 'KeyG', metaKey: true })).toBe('editor.action.nextMatchFindAction');
      expect(win(F3)).toBe('editor.action.nextMatchFindAction');
      expect(win({ key: 'G', code: 'KeyG', metaKey: true, shiftKey: true })).toBe('editor.action.previousMatchFindAction');
      expect(win({ key: 'ƒ', code: 'KeyF', metaKey: true, altKey: true })).toBe('editor.action.startFindReplaceAction');
    }
    const term = document.createElement('div');
    term.className = 'xterm';
    const ta = document.body.appendChild(term).appendChild(document.createElement('textarea'));
    expect(winningCommandFor(press(ta, { key: 'f', code: 'KeyF', metaKey: true }), all, 'mac', {})?.id).toBe('terminal.search.toggle');
  });

  it('Windows / Linux:Ctrl+G 仍是转到行(不是查找下一个)', () => {
    const v = mountEditor();
    expect(winningCommandFor(press(v.contentDOM, { key: 'g', code: 'KeyG', ctrlKey: true }), coApp.commands.getAll(), 'other', {})?.id).toBe(
      'workbench.action.gotoLine',
    );
  });
});

describe('CodeEditor 的 CodeMirror 键表不再处理这些键', () => {
  it('⌘F / ⌘G / F3 / ⇧F3 / 替换键不在键表里(两平台);Esc 关闭查找面板仍在', () => {
    const bindings = EditorState.create({ extensions: [codeEditorBasicSetup, codeEditorFind] }).facet(keymap).flat();
    for (const run of [openSearchPanel, findNext, findPrevious, openReplacePanel]) {
      expect(bindings.some((b) => b.run === run || b.shift === run)).toBe(false);
    }
    expect(bindings.some((b) => b.key === 'Escape')).toBe(true);
  });

  it('正文与查找面板里按 Ctrl+F / Ctrl+H / F3:CodeMirror 不处理(交给注册表)', () => {
    const v = mountEditor();
    for (const init of [CTRL_F, CTRL_H, F3, SHIFT_F3, CTRL_SHIFT_G]) {
      expect(runScopeHandlers(v, new KeyboardEvent('keydown', init), 'editor'), JSON.stringify(init)).toBe(false);
    }
    openSearchPanel(v);
    for (const init of [CTRL_F, CTRL_H, F3, SHIFT_F3]) {
      expect(runScopeHandlers(v, new KeyboardEvent('keydown', init), 'search-panel'), JSON.stringify(init)).toBe(false);
    }
    expect(runScopeHandlers(v, new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }), 'search-panel')).toBe(true);
  });

  it('Markdown 代码块(Crepe 的 CodeMirror)保留自带的 Ctrl+F / F3 与 Ctrl+H', () => {
    const parent = document.body.appendChild(document.createElement('div'));
    const block = new EditorView({ parent, state: EditorState.create({ doc: DOC, extensions: [basicSetup, markdownCodeBlockTheme] }) });
    views.push(block);
    expect(runScopeHandlers(block, new KeyboardEvent('keydown', CTRL_F), 'editor')).toBe(true);
    expect(runScopeHandlers(block, new KeyboardEvent('keydown', F3), 'search-panel')).toBe(true);
    expect(runScopeHandlers(block, new KeyboardEvent('keydown', CTRL_H), 'editor')).toBe(true);
  });
});

describe('经注册表分发(全局按键)', () => {
  it('正文 Ctrl+F → 打开查找面板、焦点在查找框;查找框里再按 → 全选查找词', () => {
    renderHook(() => useCommandHotkeys(coApp.commands));
    const v = mountEditor();
    expect(press(v.contentDOM, CTRL_F).defaultPrevented).toBe(true);
    expect(searchPanelOpen(v.state)).toBe(true);
    const input = searchField(v)!;
    expect(document.activeElement).toBe(input);
    input.value = 'foo';
    input.setSelectionRange(3, 3);
    press(input, CTRL_F);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
  });

  it('F3 / ⇧F3 在正文与查找框里跳下一个 / 上一个匹配;Ctrl+H 聚焦替换框', () => {
    renderHook(() => useCommandHotkeys(coApp.commands));
    const v = mountEditor();
    press(v.contentDOM, CTRL_F);
    const input = searchField(v)!;
    input.value = 'foo';
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })); // 面板在 keyup 时提交查询
    v.dispatch({ selection: EditorSelection.cursor(0) });
    press(input, F3);
    expect(head(v)).toBe(3); // 第 1 个 foo 之后
    press(input, F3);
    expect(head(v)).toBe(11); // 第 2 个
    press(input, SHIFT_F3);
    expect(head(v)).toBe(3);
    press(input, CTRL_H);
    expect(document.activeElement).toBe(replaceField(v));
  });

  it('复现:把「查找」改到 Ctrl+Shift+G、把切换侧栏绑到 Ctrl+F → 编辑器里 Ctrl+F 交给切换侧栏,Ctrl+Shift+G 打开查找面板', () => {
    const overrides = { 'actions.find': 'mod+shift+g', 'explorer.toggleSidebar': 'mod+f' };
    useKeybindingsStore.setState({ overrides });
    renderHook(() => useCommandHotkeys(coApp.commands));
    const v = mountEditor();
    expect(winningCommandFor(press(v.contentDOM, CTRL_F), coApp.commands.getAll(), 'other', overrides)?.id).toBe('explorer.toggleSidebar');
    expect(searchPanelOpen(v.state)).toBe(false);
    const sel = v.state.selection.main;
    press(v.contentDOM, CTRL_SHIFT_G);
    expect(searchPanelOpen(v.state)).toBe(true);
    expect(document.activeElement).toBe(searchField(v));
    expect(v.state.selection.main.eq(sel)).toBe(true); // 不是「查找上一个」
  });

  it('把查找下一个改到 Ctrl+J → F3 失效(CodeMirror 也不处理),Ctrl+J 生效;解绑查找上一个 → ⇧F3 无效', () => {
    useKeybindingsStore.setState({
      overrides: { 'editor.action.nextMatchFindAction': 'mod+j', 'editor.action.previousMatchFindAction': '' },
    });
    renderHook(() => useCommandHotkeys(coApp.commands));
    const v = mountEditor();
    press(v.contentDOM, CTRL_F);
    const input = searchField(v)!;
    input.value = 'foo';
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    v.dispatch({ selection: EditorSelection.cursor(0) });
    expect(press(input, F3).defaultPrevented).toBe(false);
    expect(head(v)).toBe(0);
    press(input, { key: 'j', code: 'KeyJ', keyCode: 74, ctrlKey: true });
    expect(head(v)).toBe(3);
    expect(press(input, SHIFT_F3).defaultPrevented).toBe(false);
    expect(head(v)).toBe(3);
  });
});
