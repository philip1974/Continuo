// @vitest-environment jsdom
// BDD:复制路径 / 复制相对路径的默认键(VSCode fileCommands.ts)与作用对象(资源管理器获焦 → 焦点项 / 多选项;否则活动文件)。
// 见同目录 README 第 6 条。
import { afterEach, describe, expect, it } from 'vitest';
import { copyPathCommandKeys, editorCommandSpecs } from '@/panels/Editor/editor-commands';
import {
  COPY_FILE_PATH_COMMAND_ID,
  COPY_RELATIVE_FILE_PATH_COMMAND_ID,
  onExplorerRequest,
  __resetExplorerRequestsForTest,
  type ExplorerRequest,
} from '@/panels/Explorer/explorer-requests';
import { EXPLORER_FILE_TREE_ATTR } from '@/panels/Explorer/tree-keyboard';
import { buildCompiledBindings, winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { TEXT_EDITOR_ATTR, TERMINAL_ATTR, whenCoveredBy, whenHolds, whenOverlaps } from '@/lib/editor-text-focus';
import { isTerminalKeptHotkey } from '@/panels/Terminal/terminal-hotkeys';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';

afterEach(() => {
  document.body.innerHTML = '';
  __resetExplorerRequestsForTest();
});

describe('默认键', () => {
  it('mac / Linux:编辑器之外 ⌥⌘C / ⇧⌥⌘C(Linux Ctrl+Alt+C / Ctrl+Shift+Alt+C)', () => {
    for (const k of [copyPathCommandKeys('mac', false), copyPathCommandKeys('other', false)]) {
      expect(k.copyFilePath).toEqual({ id: COPY_FILE_PATH_COMMAND_ID, hotkey: 'mod+alt+c', when: '!editorFocus' });
      expect(k.copyRelativeFilePath).toEqual({ id: COPY_RELATIVE_FILE_PATH_COMMAND_ID, hotkey: 'mod+shift+alt+c', when: '!editorFocus' });
    }
  });

  it('Windows:复制路径 Shift+Alt+C(编辑器里也是);复制相对路径是和弦 → 无默认键', () => {
    const k = copyPathCommandKeys('other', true);
    expect(k.copyFilePath).toEqual({ id: COPY_FILE_PATH_COMMAND_ID, hotkey: 'shift+alt+c' });
    expect(k.copyRelativeFilePath.hotkey).toBeUndefined();
  });

  it('命令注册用的就是这组键', () => {
    const specs = editorCommandSpecs('mac', false);
    expect(specs.find((c) => c.id === COPY_FILE_PATH_COMMAND_ID)?.hotkey).toBe('mod+alt+c');
    expect(specs.find((c) => c.id === COPY_RELATIVE_FILE_PATH_COMMAND_ID)?.when).toBe('!editorFocus');
  });
});

function el(attr: string, inner = false): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute(attr, '');
  const child = document.createElement('div');
  if (attr === TEXT_EDITOR_ATTR) host.className = 'cm-editor';
  if (inner) child.className = 'cm-content';
  host.appendChild(child);
  document.body.appendChild(host);
  return child;
}

function keydown(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

describe('!editorFocus 条件', () => {
  it('编辑器里不成立;资源管理器 / 终端 / 其它地方成立', () => {
    const optCmdC = { key: 'ç', code: 'KeyC', metaKey: true, altKey: true };
    expect(whenHolds('!editorFocus', keydown(el(TEXT_EDITOR_ATTR, true), optCmdC))).toBe(false);
    expect(whenHolds('!editorFocus', keydown(el(EXPLORER_FILE_TREE_ATTR), optCmdC))).toBe(true);
    expect(whenHolds('!editorFocus', keydown(el(TERMINAL_ATTR), optCmdC))).toBe(true);
  });

  it('与编辑器类条件互斥、与终端类重叠;终端类被它覆盖', () => {
    expect(whenOverlaps('!editorFocus', 'editorFocus')).toBe(false);
    expect(whenOverlaps('editorTextFocus', '!editorFocus')).toBe(false);
    expect(whenOverlaps('!editorFocus', 'terminalFocus')).toBe(true);
    expect(whenCoveredBy('terminalFocus', '!editorFocus')).toBe(true);
    expect(whenCoveredBy('editorFocus', '!editorFocus')).toBe(false);
  });

  it('编辑器里按 ⌥⌘C 不分发复制路径(留给查找的区分大小写);资源管理器里分发', () => {
    const commands: CommandSpec[] = editorCommandSpecs('mac', false);
    const opt = { key: 'ç', code: 'KeyC', metaKey: true, altKey: true };
    expect(winningCommandFor(keydown(el(TEXT_EDITOR_ATTR, true), opt), commands, 'mac', {})?.id).not.toBe(COPY_FILE_PATH_COMMAND_ID);
    expect(winningCommandFor(keydown(el(EXPLORER_FILE_TREE_ATTR), opt), commands, 'mac', {})?.id).toBe(COPY_FILE_PATH_COMMAND_ID);
    expect(buildCompiledBindings(commands, 'mac').some((b) => b.cmd.id === COPY_RELATIVE_FILE_PATH_COMMAND_ID)).toBe(true);
  });

  it('终端里:不带 ⌘ 的键(Linux Ctrl+Alt+C)交给 shell;mac ⌥⌘C 带 ⌘ → 让出给命令', () => {
    const term = el(TERMINAL_ATTR);
    const registry = { getAll: () => editorCommandSpecs('other', false) };
    expect(isTerminalKeptHotkey(keydown(term, { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }), 'other', {}, registry)).toBe(true);
    const macRegistry = { getAll: () => editorCommandSpecs('mac', false) };
    expect(isTerminalKeptHotkey(keydown(term, { key: 'ç', code: 'KeyC', metaKey: true, altKey: true }), 'mac', {}, macRegistry)).toBe(false);
  });
});

describe('作用对象', () => {
  it('资源管理器文件树获焦 → 请求文件树复制其焦点项 / 多选项(相对路径同)', () => {
    const got: ExplorerRequest[] = [];
    const off = onExplorerRequest((r) => (got.push(r), true));
    const tree = document.createElement('div');
    tree.setAttribute(EXPLORER_FILE_TREE_ATTR, '');
    const row = document.createElement('div');
    row.setAttribute('role', 'treeitem');
    row.tabIndex = 0;
    tree.appendChild(row);
    document.body.appendChild(tree);
    row.focus();
    const specs = editorCommandSpecs('mac', false);
    void specs.find((c) => c.id === COPY_FILE_PATH_COMMAND_ID)!.fn();
    void specs.find((c) => c.id === COPY_RELATIVE_FILE_PATH_COMMAND_ID)!.fn();
    off();
    expect(got).toEqual([
      { kind: 'copyPath', relative: false },
      { kind: 'copyPath', relative: true },
    ]);
  });

  it('焦点不在文件树 → 不发请求(复制活动文件)', () => {
    const got: ExplorerRequest[] = [];
    const off = onExplorerRequest((r) => (got.push(r), true));
    void editorCommandSpecs('mac', false).find((c) => c.id === COPY_FILE_PATH_COMMAND_ID)!.fn();
    off();
    expect(got).toEqual([]);
  });
});
