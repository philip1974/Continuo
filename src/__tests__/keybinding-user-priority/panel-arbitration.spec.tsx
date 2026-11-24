// @vitest-environment jsdom
// BDD: keybinding-user-priority / 面板与全局分发一张表裁决(winningCommandFor)。见同目录 README「面板 / 终端」节。
// jsdom detectPlatform() = 'other' → mod = Ctrl。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { editorCommandSpecs, SAVE_COMMAND } from '../../panels/Editor/editor-commands';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import {
  selectShadowedBindings,
  useCommandHotkeys,
  winningCommandFor,
} from '../../plugins/command-palette/useCommandHotkeys';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { coApp } from '../../plugins/co-app';
import type { Disposable } from '../../plugins/types';

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));

// 代码编辑器替身:Ctrl+D 当作 CodeMirror 自有绑定(选中下一处)—— 处理并 preventDefault。
vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => (
    <div
      data-testid="code-editor"
      className="cm-editor"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === 'd') e.preventDefault();
      }}
    >
      {value}
    </div>
  ),
}));
vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: () => <div data-testid="milkdown-editor" />,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: { readFile: mocks.readFile, writeFile: mocks.writeFile, onDirChanged: vi.fn(() => vi.fn()) },
    shell: { openExternal: vi.fn() },
    window: { close: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const A = '/work/a.ts';
const B = '/work/b.ts';
const tab = (path: string, dirty = false): EditorTab => ({
  id: path,
  filePath: path,
  content: dirty ? 'mine' : 'orig',
  originalContent: 'orig',
  dirty,
});

let registered: Disposable[] = [];
const newTerminal = vi.fn();

/** 与真实应用一样:命令注册在 coApp.commands,全局分发也监听它。 */
function mountWorkbench() {
  for (const spec of editorCommandSpecs(detectPlatform())) registered.push(coApp.commands.register(spec));
  registered.push(coApp.commands.register({ id: 'terminal.new', title: 'New Terminal', hotkey: 'mod+t', fn: newTerminal }));
  function Hotkeys({ registry }: { readonly registry: CommandRegistry }) {
    useCommandHotkeys(registry);
    return null;
  }
  render(
    <>
      <Hotkeys registry={coApp.commands} />
      <EditorPanel />
    </>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
  mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
  useKeybindingsStore.setState({ overrides: {} });
  useEditorStore.setState({ tabs: [tab(A, true), tab(B)], activeTabId: A, mode: 'source' });
});
afterEach(() => {
  cleanup();
  for (const d of registered) d.dispose();
  registered = [];
});

describe('winningCommandFor:与分发 / 冲突标注同表同序', () => {
  it('用户绑定压过默认;胜出者与 selectShadowedBindings 的判定一致', () => {
    const cmds = [
      { ...SAVE_COMMAND, title: 'Save', fn: () => {} },
      { id: 'terminal.new', title: 'New Terminal', hotkey: 'mod+t', fn: () => {} },
    ];
    const o = { 'terminal.new': 'mod+s' };
    const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true });
    expect(winningCommandFor(ev, cmds, 'other', o)?.id).toBe('terminal.new');
    expect(selectShadowedBindings(cmds, 'other', o).get(SAVE_COMMAND.id)?.id).toBe('terminal.new');
    expect(winningCommandFor(ev, cmds, 'other', {})?.id).toBe(SAVE_COMMAND.id);
    expect(winningCommandFor(new KeyboardEvent('keydown', { key: 'q', ctrlKey: true }), cmds, 'other', {})).toBeUndefined();
  });
});

describe('编辑器面板:只在胜出命令是保存 / 下一个 / 上一个时就地处理', () => {
  it('新建终端改绑到 Ctrl+S(冲突胜出):焦点在编辑器里按 Ctrl+S 不保存,执行新建终端一次', async () => {
    useKeybindingsStore.setState({ overrides: { 'terminal.new': 'mod+s' } });
    mountWorkbench();
    const editor = await screen.findByTestId('code-editor');
    await act(async () => {
      fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(newTerminal).toHaveBeenCalledTimes(1);
  });

  it('保存改绑到编辑器自有键 Ctrl+D:编辑器已处理(defaultPrevented)→ 面板不再保存', async () => {
    useKeybindingsStore.setState({ overrides: { [SAVE_COMMAND.id]: 'mod+d' } });
    mountWorkbench();
    const editor = await screen.findByTestId('code-editor');
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'd', ctrlKey: true });
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('默认绑定照常:焦点在编辑器里 Ctrl+S 保存一次', async () => {
    mountWorkbench();
    const editor = await screen.findByTestId('code-editor');
    await act(async () => {
      fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(newTerminal).not.toHaveBeenCalled();
  });
});
