// @vitest-environment jsdom
// BDD: editor-text-commands 第 1 条 —— 命令 id / 标题 / 默认键(对齐 VSCode)、命令面板可搜到、改键 / 解绑。见同目录 README。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { editorTextCommandSpecs } from '@/panels/Editor/editor-text-commands';
import { winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { tWithFallback } from '@/i18n';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());

/** [id, VSCode 英文标题, mac 默认键, Windows / Linux 默认键] */
const EXPECTED: readonly (readonly [string, string, string | undefined, string | undefined])[] = [
  ['editor.action.commentLine', 'Toggle Line Comment', 'mod+/', 'mod+/'],
  ['editor.action.blockComment', 'Toggle Block Comment', 'shift+alt+a', 'shift+alt+a'],
  ['editor.action.moveLinesUpAction', 'Move Line Up', 'alt+up', 'alt+up'],
  ['editor.action.moveLinesDownAction', 'Move Line Down', 'alt+down', 'alt+down'],
  ['editor.action.copyLinesUpAction', 'Copy Line Up', 'shift+alt+up', 'shift+alt+up'],
  ['editor.action.copyLinesDownAction', 'Copy Line Down', 'shift+alt+down', 'shift+alt+down'],
  ['editor.action.deleteLines', 'Delete Line', 'mod+shift+k', 'mod+shift+k'],
  ['editor.action.insertLineAfter', 'Insert Line Below', 'mod+enter', 'mod+enter'],
  ['editor.action.insertLineBefore', 'Insert Line Above', 'mod+shift+enter', 'mod+shift+enter'],
  ['editor.action.indentLines', 'Indent Line', 'mod+]', 'mod+]'],
  ['editor.action.outdentLines', 'Outdent Line', 'mod+[', 'mod+['],
  ['editor.action.addSelectionToNextFindMatch', 'Add Selection to Next Find Match', 'mod+d', 'mod+d'],
  ['editor.action.selectHighlights', 'Select All Occurrences of Find Match', 'mod+shift+l', 'mod+shift+l'],
  ['editor.action.insertCursorAbove', 'Add Cursor Above', 'mod+alt+up', 'ctrl+alt+up'],
  ['editor.action.insertCursorBelow', 'Add Cursor Below', 'mod+alt+down', 'ctrl+alt+down'],
  ['expandLineSelection', 'Expand Line Selection', 'mod+l', 'mod+l'],
  ['editor.fold', 'Fold', 'mod+alt+[', 'ctrl+shift+['],
  ['editor.unfold', 'Unfold', 'mod+alt+]', 'ctrl+shift+]'],
  ['editor.foldAll', 'Fold All', undefined, undefined],
  ['editor.unfoldAll', 'Unfold All', undefined, undefined],
  ['editor.action.jumpToBracket', 'Go to Bracket', 'mod+shift+\\', 'mod+shift+\\'],
  ['cursorUndo', 'Cursor Undo', 'mod+u', 'mod+u'],
];

/** 在代码编辑器(CodeEditor)正文里按下的键(已派发,target = .cm-content)。 */
function keyInEditor(init: KeyboardEventInit): KeyboardEvent {
  const editor = document.createElement('div');
  editor.className = 'cm-editor';
  editor.setAttribute('data-co-text-editor', '');
  const content = document.createElement('div');
  content.className = 'cm-content';
  content.contentEditable = 'true';
  editor.appendChild(content);
  document.body.appendChild(editor);
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  content.dispatchEvent(e);
  editor.remove();
  return e;
}

describe('命令表(对齐 VSCode)', () => {
  it.each(EXPECTED)('%s:标题「%s」,mac %s,Windows / Linux %s,条件 editorTextFocus', (id, title, mac, other) => {
    const macSpec = editorTextCommandSpecs('mac').find((s) => s.id === id);
    const otherSpec = editorTextCommandSpecs('other').find((s) => s.id === id);
    expect(macSpec?.title).toBe(title);
    expect(macSpec?.hotkey).toBe(mac);
    expect(otherSpec?.hotkey).toBe(other);
    expect(macSpec?.when).toBe('editorTextFocus');
  });

  it('只有这些命令(每个命令一个默认键)', () => {
    expect(editorTextCommandSpecs('mac').map((s) => s.id)).toEqual(EXPECTED.map((r) => r[0]));
  });

  it('核心插件注册,三语标题齐全,英文与 VSCode 一致', () => {
    for (const [id, title] of EXPECTED) {
      const spec = coApp.commands.get(id);
      expect(spec, id).toBeDefined();
      const k = spec!.titleKey as keyof typeof en;
      expect(en[k]).toBe(title);
      expect(zh[k]).toBeTruthy();
      expect(ko[k]).toBeTruthy();
    }
    expect(zh['commands.editor.text.comment_line.title' as keyof typeof zh]).toBe('切换行注释');
  });

  it('命令面板可搜到(comment / select / fold 不再为空)', () => {
    const titles = coApp.commands.getAll().map((c) => tWithFallback(c.titleKey, c.title).toLowerCase() + ' ' + c.title.toLowerCase());
    for (const q of ['comment', 'select', 'fold']) expect(titles.some((t) => t.includes(q)), q).toBe(true);
  });
});

describe('改键 / 解绑(Windows / Linux:mod = Ctrl)', () => {
  const all = (): ReturnType<typeof coApp.commands.getAll> => coApp.commands.getAll();

  it('默认:编辑器里 Ctrl+/ 胜出为切换行注释,Ctrl+L 为选中行', () => {
    expect(winningCommandFor(keyInEditor({ key: '/', code: 'Slash', ctrlKey: true }), all(), 'other', {})?.id).toBe(
      'editor.action.commentLine',
    );
    expect(winningCommandFor(keyInEditor({ key: 'l', code: 'KeyL', ctrlKey: true }), all(), 'other', {})?.id).toBe(
      'expandLineSelection',
    );
  });

  it('把切换行注释改到 Ctrl+Shift+7 → 新键生效、旧键 Ctrl+/ 失效', () => {
    const overrides = { 'editor.action.commentLine': 'mod+shift+7' };
    expect(
      winningCommandFor(keyInEditor({ key: '&', code: 'Digit7', ctrlKey: true, shiftKey: true }), all(), 'other', overrides)?.id,
    ).toBe('editor.action.commentLine');
    expect(winningCommandFor(keyInEditor({ key: '/', code: 'Slash', ctrlKey: true }), all(), 'other', overrides)?.id).toBeUndefined();
  });

  it('解绑 → 原键不再执行', () => {
    const overrides = { expandLineSelection: '' };
    expect(winningCommandFor(keyInEditor({ key: 'l', code: 'KeyL', ctrlKey: true }), all(), 'other', overrides)?.id).toBeUndefined();
  });
});
