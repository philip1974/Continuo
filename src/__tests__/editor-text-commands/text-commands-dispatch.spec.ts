// @vitest-environment jsdom
// BDD: editor-text-commands 第 3 / 4 条 —— `editorTextFocus` 分发(编辑器 / 终端 / 输入框 / Milkdown 代码块 / 组字 / popout)、
// ⇧⌘Enter 编辑器内插入上方行而终端内仍缩放、冲突判定不误报。见同目录 README。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import {
  isPopoutHotkeyCommand,
  selectShadowedBindings,
  winningCommandFor,
} from '@/plugins/command-palette/useCommandHotkeys';
import { CommandRegistry } from '@/plugins/registries/CommandRegistry';
import { selectKeybindingConflicts } from '@/plugins/keybindings/KeybindingCaptureModal';
import { isTerminalZoomHotkey, terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import { editorTextCommandSpecs } from '@/panels/Editor/editor-text-commands';

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());
afterEach(() => {
  document.body.innerHTML = '';
});

const ZOOM = 'terminal.zoom.toggle';
const all = (): ReturnType<typeof coApp.commands.getAll> => coApp.commands.getAll();

/** 代码编辑器(CodeEditor)结构:.cm-editor[data-co-text-editor] > .cm-content + .cm-panels input(查找面板)。 */
function codeEditorDom(): { content: HTMLElement; findInput: HTMLInputElement } {
  const editor = document.createElement('div');
  editor.className = 'cm-editor';
  editor.setAttribute('data-co-text-editor', '');
  const content = document.createElement('div');
  content.className = 'cm-content';
  content.contentEditable = 'true';
  const panels = document.createElement('div');
  panels.className = 'cm-panels';
  const findInput = document.createElement('input');
  panels.appendChild(findInput);
  editor.append(content, panels);
  document.body.appendChild(editor);
  return { content, findInput };
}

/** Milkdown 代码块:.ProseMirror 内嵌的 CodeMirror(不是 CodeEditor,无标记)。 */
function milkdownCodeBlockContent(): HTMLElement {
  const pm = document.createElement('div');
  pm.className = 'ProseMirror';
  pm.contentEditable = 'true';
  const cm = document.createElement('div');
  cm.className = 'cm-editor';
  const content = document.createElement('div');
  content.className = 'cm-content';
  content.contentEditable = 'true';
  cm.appendChild(content);
  pm.appendChild(cm);
  document.body.appendChild(pm);
  return content;
}

function xtermTextarea(): HTMLTextAreaElement {
  const term = document.createElement('div');
  term.className = 'xterm';
  const ta = document.createElement('textarea');
  ta.className = 'xterm-helper-textarea';
  term.appendChild(ta);
  document.body.appendChild(term);
  return ta;
}

function pressOn(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

const MAC_COMMENT: KeyboardEventInit = { key: '/', code: 'Slash', metaKey: true };
const ALT_UP: KeyboardEventInit = { key: 'ArrowUp', code: 'ArrowUp', altKey: true };
const SHIFT_CMD_ENTER: KeyboardEventInit = { key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true };

describe('editorTextFocus:只有按键落在代码编辑器正文里才执行', () => {
  it('代码编辑器正文:⌘/ → 切换行注释,⌥↑ → 上移行', () => {
    const { content } = codeEditorDom();
    expect(winningCommandFor(pressOn(content, MAC_COMMENT), all(), 'mac', {})?.id).toBe('editor.action.commentLine');
    expect(winningCommandFor(pressOn(content, ALT_UP), all(), 'mac', {})?.id).toBe('editor.action.moveLinesUpAction');
  });

  it('终端:⌘/、⌥↑ 不执行编辑器命令,也不让出(照常进 shell)', () => {
    const ta = xtermTextarea();
    for (const init of [MAC_COMMENT, ALT_UP]) {
      expect(winningCommandFor(pressOn(ta, init), all(), 'mac', {})).toBeUndefined();
      expect(terminalYieldedCommandId(pressOn(ta, init), 'mac', {}, coApp.commands)).toBeNull();
    }
  });

  it('查找面板输入框 / 其它输入框 / 页面其它位置:不执行', () => {
    const { findInput } = codeEditorDom();
    const input = document.createElement('input');
    document.body.appendChild(input);
    for (const target of [findInput, input, document.body]) {
      expect(winningCommandFor(pressOn(target, MAC_COMMENT), all(), 'mac', {})).toBeUndefined();
    }
  });

  it('Milkdown 代码块里的 CodeMirror 不受影响', () => {
    const content = milkdownCodeBlockContent();
    expect(winningCommandFor(pressOn(content, MAC_COMMENT), all(), 'mac', {})).toBeUndefined();
  });

  it('输入法组字中不执行', () => {
    const { content } = codeEditorDom();
    expect(winningCommandFor(pressOn(content, { ...ALT_UP, isComposing: true }), all(), 'mac', {})).toBeUndefined();
  });

  it('popout 子窗里也分发(只作用于该子窗的编辑器)', () => {
    for (const spec of editorTextCommandSpecs('mac')) expect(isPopoutHotkeyCommand(spec)).toBe(true);
    expect(isPopoutHotkeyCommand({ id: 'x' })).toBe(false);
  });
});

describe('⇧⌘Enter:编辑器内插入上方行,终端内仍切换缩放', () => {
  it('编辑器正文 → editor.action.insertLineBefore', () => {
    const { content } = codeEditorDom();
    expect(winningCommandFor(pressOn(content, SHIFT_CMD_ENTER), all(), 'mac', {})?.id).toBe('editor.action.insertLineBefore');
  });

  it('终端 → 让出给缩放;其它位置 → 缩放', () => {
    const ta = xtermTextarea();
    expect(isTerminalZoomHotkey(pressOn(ta, SHIFT_CMD_ENTER), 'mac', {}, coApp.commands)).toBe(true);
    expect(winningCommandFor(pressOn(document.body, SHIFT_CMD_ENTER), all(), 'mac', {})?.id).toBe(ZOOM);
  });

  it('Windows / Linux 同理(Ctrl+Shift+Enter)', () => {
    const { content } = codeEditorDom();
    const init = { key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true };
    expect(winningCommandFor(pressOn(content, init), all(), 'other', {})?.id).toBe('editor.action.insertLineBefore');
    expect(winningCommandFor(pressOn(document.body, init), all(), 'other', {})?.id).toBe(ZOOM);
  });
});

describe('冲突判定不误报', () => {
  it('默认键位:编辑器命令与缩放都不标「冲突」(两平台)', () => {
    for (const platform of ['mac', 'other'] as const) {
      const shadowed = selectShadowedBindings(all(), platform, {});
      expect(shadowed.has(ZOOM)).toBe(false);
      for (const spec of editorTextCommandSpecs(platform)) expect(shadowed.has(spec.id), spec.id).toBe(false);
    }
  });

  it('条件相同的两条仍是冲突:把选中行改到 ⌘/ → 切换行注释落败', () => {
    const shadowed = selectShadowedBindings(all(), 'mac', { expandLineSelection: 'mod+/' });
    expect(shadowed.get('editor.action.commentLine')?.id).toBe('expandLineSelection');
  });

  it('无条件的用户绑定完全压过编辑器命令 → 冲突:把缩放改到 ⌘/ → 切换行注释落败', () => {
    const shadowed = selectShadowedBindings(all(), 'mac', { [ZOOM]: 'mod+/' });
    expect(shadowed.get('editor.action.commentLine')?.id).toBe(ZOOM);
  });

  it('注册表不为条件不同的同键默认绑定告警;条件相同仍告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reg = new CommandRegistry('mac');
      reg.register({ id: 'zoom', title: 'Zoom', hotkey: 'shift+mod+enter', fn: () => {} });
      reg.register({ id: 'above', title: 'Above', hotkey: 'mod+shift+enter', when: 'editorTextFocus', fn: () => {} });
      expect(warn).not.toHaveBeenCalled();
      reg.register({ id: 'above2', title: 'Above 2', hotkey: 'mod+shift+enter', when: 'editorTextFocus', fn: () => {} });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('注册时拒绝未知的 when', () => {
    const reg = new CommandRegistry('mac');
    expect(() =>
      reg.register({ id: 'bad', title: 'Bad', when: 'terminalFocus' as unknown as 'editorTextFocus', fn: () => {} }),
    ).toThrow();
  });

  it('改键弹窗:录 ⇧⌘Enter 给在上方插入行不列缩放为冲突;录 ⇧⌘K 给切换行注释列出删除行', () => {
    expect(selectKeybindingConflicts(all(), 'editor.action.insertLineBefore', 'mod+shift+enter').map((c) => c.id)).not.toContain(ZOOM);
    expect(selectKeybindingConflicts(all(), 'editor.action.commentLine', 'mod+shift+k').map((c) => c.id)).toContain(
      'editor.action.deleteLines',
    );
  });
});
