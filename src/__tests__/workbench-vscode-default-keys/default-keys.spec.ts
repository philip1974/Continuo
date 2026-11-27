// @vitest-environment jsdom
// BDD: workbench-vscode-default-keys —— ⌘J / ⇧⌘D / ⇧⌘U / ⇧⌘V 按 VSCode 默认键分发到已有命令。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { redoSelection } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import { codeEditorBasicSetup } from '@/panels/Editor/codemirror-basic-setup';
import { codeEditorTextCommands } from '@/panels/Editor/codemirror-text-commands';
import { pickLanguage } from '@/panels/Editor/CodeEditor';
import { registerMarkdownModeAction } from '@/panels/Editor/editor-commands';
import { registerEditorFocus } from '@/panels/Editor/editor-focus-registry';
import { createTab, useEditorStore, type EditorMode } from '@/stores/editor.store';
import { MARKDOWN_EDITOR_ATTR, TERMINAL_ATTR } from '@/lib/editor-text-focus';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  document.body.innerHTML = '';
});

const all = (): ReturnType<typeof coApp.commands.getAll> => coApp.commands.getAll();

/** 在 target 上派发 keydown,返回事件(target 缺省 body)。 */
function press(init: KeyboardEventInit, target: Element = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function codeView(path: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: '# t\n', extensions: [codeEditorBasicSetup, codeEditorTextCommands(), pickLanguage(path)] }),
    parent,
  });
  cleanups.push(() => view.destroy());
  return view;
}

function terminalTarget(): Element {
  const host = document.createElement('div');
  host.setAttribute(TERMINAL_ATTR, '');
  const ta = document.createElement('textarea');
  host.appendChild(ta);
  document.body.appendChild(host);
  return ta;
}

function milkdownTarget(): Element {
  const wrap = document.createElement('div');
  wrap.setAttribute(MARKDOWN_EDITOR_ATTR, '');
  const pm = document.createElement('div');
  pm.contentEditable = 'true';
  wrap.appendChild(pm);
  document.body.appendChild(wrap);
  return pm;
}

const J = { key: 'j', code: 'KeyJ' };
const D = { key: 'd', code: 'KeyD', shiftKey: true };
const U = { key: 'u', code: 'KeyU', shiftKey: true };
const V = { key: 'v', code: 'KeyV', shiftKey: true };
const MOD = { mac: { metaKey: true }, other: { ctrlKey: true } } as const;

describe('⌘J / ⇧⌘D / ⇧⌘U:已有命令补上 VSCode 默认键', () => {
  it.each(['mac', 'other'] as const)('%s:⌘J → 切换终端,⇧⌘D → 显示调试,⇧⌘U → 显示输出', (platform) => {
    const m = MOD[platform];
    expect(winningCommandFor(press({ ...J, ...m }), all(), platform, {})?.id).toBe('workbench.action.terminal.toggleTerminal');
    expect(winningCommandFor(press({ ...D, ...m }), all(), platform, {})?.id).toBe('workbench.view.debug');
    expect(winningCommandFor(press({ ...U, ...m }), all(), platform, {})?.id).toBe('workbench.view.output');
  });

  it('切换终端主键仍是 ⌃`,⌘J 是附加默认键;显示调试 / 输出的主键即 ⇧⌘D / ⇧⌘U', () => {
    const toggle = coApp.commands.get('workbench.action.terminal.toggleTerminal');
    expect(toggle?.hotkey).toBe('ctrl+`');
    expect(toggle?.secondaryHotkeys).toEqual(['mod+j']);
    expect(coApp.commands.get('workbench.view.debug')?.hotkey).toBe('mod+shift+d');
    expect(coApp.commands.get('workbench.view.output')?.hotkey).toBe('mod+shift+u');
  });

  it.each(['mac', 'other'] as const)('%s:终端获焦时 ⌘J / Ctrl+J 让出给切换终端(VSCode togglePanel 在 commandsToSkipShell 里)', (platform) => {
    const e = press({ ...J, ...MOD[platform] }, terminalTarget());
    expect(terminalYieldedCommandId(e, platform, {}, coApp.commands)).toBe('workbench.action.terminal.toggleTerminal');
  });

  it('⌘J 在代码编辑器 / Markdown 编辑里同样切换终端(没有同键的编辑器命令)', () => {
    const view = codeView('/w/a.ts');
    expect(winningCommandFor(press({ ...J, metaKey: true }, view.contentDOM), all(), 'mac', {})?.id).toBe(
      'workbench.action.terminal.toggleTerminal',
    );
    expect(winningCommandFor(press({ ...J, metaKey: true }, milkdownTarget()), all(), 'mac', {})?.id).toBe(
      'workbench.action.terminal.toggleTerminal',
    );
  });

  it('⇧⌘U / Alt+U 不再被 CodeMirror 的「光标重做」吞掉:键表不含 redoSelection,改为无默认键的 cursorRedo 命令', () => {
    const bindings = EditorState.create({ extensions: codeEditorBasicSetup }).facet(keymap).flat();
    expect(bindings.some((b) => b.run === redoSelection)).toBe(false);
    const view = codeView('/w/a.ts');
    // jsdom 非 mac:CodeMirror 原把 Alt+U 绑给 redoSelection 并 preventDefault
    expect(press({ key: 'u', code: 'KeyU', altKey: true }, view.contentDOM).defaultPrevented).toBe(false);
    expect(press({ ...U, ctrlKey: true }, view.contentDOM).defaultPrevented).toBe(false);
    const redo = coApp.commands.get('cursorRedo');
    expect(redo?.hotkey).toBeUndefined();
    expect(en[redo!.titleKey as keyof typeof en]).toBe('Cursor Redo');
  });
});

describe('⇧⌘V:Markdown 切换预览(markdown.togglePreview)', () => {
  const ID = 'markdown.togglePreview';
  const MD = '/w/a.md';

  beforeEach(() => {
    useEditorStore.setState({
      tabs: [createTab(MD, '# t\n')],
      groups: [{ id: 'editor', tabIds: [MD], activeTabId: MD }],
      activeGroupId: 'editor',
      activeTabId: MD,
      mode: 'source',
      viewRefs: new Map(),
    });
  });

  it('命令:VSCode 同 id、英文标题 Toggle Preview(分类 Markdown),三语齐全,默认键 ⇧⌘V,条件 markdownEditorFocus', () => {
    const spec = coApp.commands.get(ID)!;
    expect(spec.hotkey).toBe('mod+shift+v');
    expect(spec.when).toBe('markdownEditorFocus');
    const k = spec.titleKey as keyof typeof en;
    expect(en[k]).toBe('Toggle Preview');
    expect(zh[k]).toBe('切换预览');
    expect(ko[k]).toBeTruthy();
    expect(en[spec.categoryKey as keyof typeof en]).toBe('Markdown');
  });

  it.each(['mac', 'other'] as const)('%s:Markdown 源码模式(CodeEditor)与编辑 / 预览(Milkdown)里胜出', (platform) => {
    const md = codeView(MD);
    expect(md.dom.hasAttribute('data-co-markdown-source')).toBe(true);
    expect(winningCommandFor(press({ ...V, ...MOD[platform] }, md.contentDOM), all(), platform, {})?.id).toBe(ID);
    expect(winningCommandFor(press({ ...V, ...MOD[platform] }, milkdownTarget()), all(), platform, {})?.id).toBe(ID);
  });

  it.each(['mac', 'other'] as const)('%s:其它文件的编辑器、终端、页面别处不胜出(Ctrl+Shift+V 照常粘贴)', (platform) => {
    const ts = codeView('/w/a.ts');
    expect(ts.dom.hasAttribute('data-co-markdown-source')).toBe(false);
    expect(winningCommandFor(press({ ...V, ...MOD[platform] }, ts.contentDOM), all(), platform, {})?.id).not.toBe(ID);
    expect(winningCommandFor(press({ ...V, ...MOD[platform] }, terminalTarget()), all(), platform, {})?.id).not.toBe(ID);
    expect(winningCommandFor(press({ ...V, ...MOD[platform] }), all(), platform, {})?.id).not.toBe(ID);
  });

  it('不在预览 → 预览并记下原模式;在预览 → 回到原模式;切换后焦点进入新视图', async () => {
    const modes: EditorMode[] = [];
    cleanups.push(
      registerMarkdownModeAction((m) => {
        modes.push(m);
        useEditorStore.setState({ mode: m });
      }, 'editor'),
    );
    const focus = vi.fn();
    cleanups.push(registerEditorFocus(MD, focus, 'editor'));
    useEditorStore.setState({ mode: 'edit' });
    await coApp.commands.execute(ID);
    expect(modes).toEqual(['preview']);
    await new Promise((r) => requestAnimationFrame(r));
    expect(focus).toHaveBeenCalledTimes(1);
    await coApp.commands.execute(ID);
    expect(modes).toEqual(['preview', 'edit']);
    useEditorStore.setState({ mode: 'source' });
    await coApp.commands.execute(ID);
    await coApp.commands.execute(ID);
    expect(modes).toEqual(['preview', 'edit', 'preview', 'source']);
  });

  it('活动 tab 不是 Markdown(从命令面板执行)→ 不切换模式、不移动焦点', async () => {
    useEditorStore.setState({
      tabs: [createTab('/w/a.ts', 'x')],
      groups: [{ id: 'editor', tabIds: ['/w/a.ts'], activeTabId: '/w/a.ts' }],
      activeTabId: '/w/a.ts',
    });
    const mode = vi.fn();
    cleanups.push(registerMarkdownModeAction(mode, 'editor'));
    const focus = vi.fn();
    cleanups.push(registerEditorFocus('/w/a.ts', focus, 'editor'));
    await coApp.commands.execute(ID);
    await new Promise((r) => requestAnimationFrame(r));
    expect(mode).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});
