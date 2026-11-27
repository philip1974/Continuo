// @vitest-environment jsdom
// BDD: editor-language-commands —— 格式化 / 重命名 / 转到定义 / 快速修复 / 下一个问题 / 触发建议 / 扩展·收缩选区。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView, keymap } from '@codemirror/view';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { selectParentSyntax, selectSyntaxLeft, selectSyntaxRight, undo } from '@codemirror/commands';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { codeEditorBasicSetup } from '@/panels/Editor/codemirror-basic-setup';
import { codeEditorTextCommands } from '@/panels/Editor/codemirror-text-commands';
import { nextDiagnosticCommand, startCompletionCommand } from '@/panels/Editor/codemirror-language-commands';
import { editorTextCommandSpecs } from '@/panels/Editor/editor-text-commands';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const views: { tabId: string; view: EditorView }[] = [];

function mount(tabId: string, doc: string, lang: Extension[] = [], anchor = 0, head = anchor): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [codeEditorBasicSetup, codeEditorTextCommands(), ...lang],
    }),
    parent,
  });
  useEditorStore.getState().openTab(createTab(tabId, doc), { groupId: 'editor' });
  useEditorStore.getState().registerView(tabId, view, 'editor');
  views.push({ tabId, view });
  return view;
}

const run = (id: string): Promise<void> => coApp.commands.execute(id);
const text = (v: EditorView): string => v.state.doc.toString();

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  useKeybindingsStore.setState({ overrides: {} });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
  info = vi.spyOn(notify, 'info').mockImplementation(() => {});
  warn = vi.spyOn(notify, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const { tabId, view } of views.splice(0)) {
    useEditorStore.getState().unregisterView(tabId, view);
    view.destroy();
  }
  document.body.innerHTML = '';
});

/** 在代码编辑器正文里按下的键。 */
function keyIn(view: EditorView, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(e);
  return e;
}

describe('键位(对齐 VSCode,含附加默认键)', () => {
  it('附加默认键:触发建议 mac ⌥Esc / ⌘I、Windows Ctrl+I;扩展 / 收缩选区 mac ⌃⇧→ / ⌃⇧←', () => {
    const mac = editorTextCommandSpecs('mac');
    const other = editorTextCommandSpecs('other');
    const of = (specs: typeof mac, id: string) => specs.find((s) => s.id === id)?.secondaryHotkeys;
    expect(of(mac, 'editor.action.triggerSuggest')).toEqual(['alt+escape', 'mod+i']);
    expect(of(other, 'editor.action.triggerSuggest')).toEqual(['mod+i']);
    expect(of(mac, 'editor.action.smartSelect.expand')).toEqual(['ctrl+shift+right']);
    expect(of(mac, 'editor.action.smartSelect.shrink')).toEqual(['ctrl+shift+left']);
    expect(of(other, 'editor.action.smartSelect.expand')).toBeUndefined();
  });

  it('编辑器正文里按键胜出:⌘I → 触发建议(不再是扩展到父语法节点),⇧⌥F / F2 / F12 / ⌘. / F8,⌃⇧⌘→ / ⌃⇧→', () => {
    const v = mount('/w/a.ts', 'x');
    // 按平台取命令表(注册表里是 jsdom 平台 other 的默认键)
    const win = (init: KeyboardEventInit, platform: 'mac' | 'other' = 'mac') =>
      winningCommandFor(keyIn(v, init), editorTextCommandSpecs(platform), platform, {})?.id;
    expect(win({ key: 'i', code: 'KeyI', metaKey: true })).toBe('editor.action.triggerSuggest');
    expect(win({ key: 'i', code: 'KeyI', ctrlKey: true }, 'other')).toBe('editor.action.triggerSuggest');
    expect(win({ key: 'Ï', code: 'KeyF', altKey: true, shiftKey: true })).toBe('editor.action.formatDocument');
    expect(win({ key: 'F2', code: 'F2' })).toBe('editor.action.rename');
    expect(win({ key: 'F12', code: 'F12' })).toBe('editor.action.revealDefinition');
    expect(win({ key: '.', code: 'Period', metaKey: true })).toBe('editor.action.quickFix');
    expect(win({ key: 'F8', code: 'F8' })).toBe('editor.action.marker.nextInFiles');
    expect(win({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, shiftKey: true, metaKey: true })).toBe(
      'editor.action.smartSelect.expand',
    );
    expect(win({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, shiftKey: true })).toBe('editor.action.smartSelect.expand');
    expect(win({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, shiftKey: true }, 'other')).toBe('editor.action.smartSelect.shrink');
  });

  it('CodeMirror 键表不再处理 ⌘I / F8 / 按语法选择(改由注册表分发,可改键);⌃Space 仍是补全自带键(同一命令)', () => {
    const bindings = EditorState.create({ extensions: codeEditorBasicSetup }).facet(keymap).flat();
    for (const run of [selectParentSyntax, nextDiagnosticCommand, selectSyntaxLeft, selectSyntaxRight]) {
      expect(bindings.some((b) => b.run === run || b.shift === run)).toBe(false);
    }
    expect(bindings.filter((b) => b.run === startCompletionCommand).map((b) => b.key ?? b.mac)).toContain('Ctrl-Space');
    const v = mount('/w/a.ts', 'x');
    // jsdom 非 mac:Mod = Ctrl
    expect(keyIn(v, { key: 'i', code: 'KeyI', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(keyIn(v, { key: 'F8', code: 'F8' }).defaultPrevented).toBe(false);
  });

  it('解绑格式化 → ⇧⌥F 不再胜出', () => {
    const v = mount('/w/a.json', '{}', [json()]);
    const e = keyIn(v, { key: 'Ï', code: 'KeyF', altKey: true, shiftKey: true });
    expect(winningCommandFor(e, coApp.commands.getAll(), 'mac', { 'editor.action.formatDocument': '' })?.id).toBeUndefined();
  });
});

describe('格式化文档', () => {
  it('JSON:按当前缩进单位格式化,一次撤销恢复原文', async () => {
    const v = mount('/w/a.json', '{"a":1,"b":[true]}\n', [json(), indentUnit.of('    ')]);
    await run('editor.action.formatDocument');
    expect(text(v)).toBe('{\n    "a": 1,\n    "b": [\n        true\n    ]\n}\n');
    undo(v);
    expect(text(v)).toBe('{"a":1,"b":[true]}\n');
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('只替换变化的部分:文末光标仍在文末', async () => {
    const doc = '{"a":1}\n';
    const v = mount('/w/a.json', doc, [json()], doc.length);
    await run('editor.action.formatDocument');
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });

  it('JSON 语法错误 → 提示且不改文档', async () => {
    const v = mount('/w/a.json', '{"a":1 "b":2}', [json()]);
    await run('editor.action.formatDocument');
    expect(text(v)).toBe('{"a":1 "b":2}');
    expect(warn).toHaveBeenCalledWith(t('editor.format.json_syntax_error'));
  });

  it('jsonc / tsconfig.json 有尾逗号 → 照常格式化,尾逗号保留(VSCode jsonc-parser format)', async () => {
    const v = mount('/w/tsconfig.json', '{"a":[1,],}', [json()]);
    await run('editor.action.formatDocument');
    expect(text(v)).toBe('{\n  "a": [\n    1,\n  ],\n}');
    expect(warn).not.toHaveBeenCalled();
  });

  it('其它语言 → 「没有格式化程序」提示(含语言名),不改文档;纯文本为 plaintext', async () => {
    const v = mount('/w/a.ts', 'let  a=1', [javascript({ typescript: true })]);
    await run('editor.action.formatDocument');
    expect(text(v)).toBe('let  a=1');
    expect(info).toHaveBeenLastCalledWith(t('editor.format.no_formatter', { name: 'typescript' }));
    useEditorStore.getState().unregisterView('/w/a.ts', v);
    mount('/w/b.txt', 'x');
    useEditorStore.getState().switchTab('/w/b.txt');
    await run('editor.action.formatDocument');
    expect(info).toHaveBeenLastCalledWith(t('editor.format.no_formatter', { name: 'plaintext' }));
    expect(t('editor.format.no_formatter', { name: 'plaintext' })).toContain('plaintext');
  });

  it('只读文档不格式化', async () => {
    const v = mount('/w/a.json', '{"a":1}', [json(), EditorState.readOnly.of(true)]);
    await run('editor.action.formatDocument');
    expect(text(v)).toBe('{"a":1}');
  });
});

describe('没有语言服务的命令:提示而不静默', () => {
  it('F2 重命名 → No result', async () => {
    mount('/w/a.ts', 'foo');
    await run('editor.action.rename');
    expect(info).toHaveBeenCalledWith(t('editor.rename.no_result'));
  });

  it('F12 转到定义 → No definition found for 光标处单词;不在单词上 → No definition found', async () => {
    const v = mount('/w/a.ts', 'foo  bar', [], 1);
    await run('editor.action.revealDefinition');
    expect(info).toHaveBeenLastCalledWith(t('editor.definition.none_for', { name: 'foo' }));
    v.dispatch({ selection: EditorSelection.cursor(4) });
    await run('editor.action.revealDefinition');
    expect(info).toHaveBeenLastCalledWith(t('editor.definition.none'));
  });

  it('⌘. 快速修复 → No code actions available', async () => {
    mount('/w/a.ts', 'foo');
    await run('editor.action.quickFix');
    expect(info).toHaveBeenCalledWith(t('editor.quick_fix.none'));
  });

  it('F8 没有诊断 → No problems', async () => {
    mount('/w/a.ts', 'foo');
    await run('editor.action.marker.nextInFiles');
    expect(info).toHaveBeenCalledWith(t('editor.problems.none'));
  });

  it('英文文案对齐 VSCode(引号按本项目 catalog 风格用弯引号),三语齐全', () => {
    expect(en['editor.definition.none_for']).toBe('No definition found for “{name}”');
    expect(en['editor.definition.none']).toBe('No definition found');
    expect(en['editor.quick_fix.none']).toBe('No code actions available');
    expect(en['editor.format.no_formatter']).toBe('There is no formatter for “{name}” files installed.');
    for (const k of ['editor.rename.no_result', 'editor.problems.none', 'editor.format.json_syntax_error'] as const) {
      expect(zh[k]).toBeTruthy();
      expect(ko[k]).toBeTruthy();
    }
  });
});

describe('扩展 / 收缩选区', () => {
  const sel = (v: EditorView): [number, number] => [v.state.selection.main.from, v.state.selection.main.to];

  it('扩展到上一层语法节点,收缩逐级退回', async () => {
    const doc = 'f(a + b);';
    const v = mount('/w/a.js', doc, [javascript()], 2);
    await run('editor.action.smartSelect.expand');
    const first = sel(v);
    expect(first).toEqual([2, 3]);
    await run('editor.action.smartSelect.expand');
    const second = sel(v);
    expect(second[0] <= first[0] && second[1] >= first[1] && (second[0] < first[0] || second[1] > first[1])).toBe(true);
    await run('editor.action.smartSelect.shrink');
    expect(sel(v)).toEqual(first);
    await run('editor.action.smartSelect.shrink');
    expect(sel(v)).toEqual([2, 2]);
    await run('editor.action.smartSelect.shrink');
    expect(sel(v)).toEqual([2, 2]);
  });

  it('期间选区被别的操作改变 → 收缩无效果', async () => {
    const v = mount('/w/a.js', 'f(a + b);', [javascript()], 2);
    await run('editor.action.smartSelect.expand');
    v.dispatch({ selection: EditorSelection.cursor(7) });
    await run('editor.action.smartSelect.shrink');
    expect(sel(v)).toEqual([7, 7]);
  });
});
