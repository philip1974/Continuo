// @vitest-environment jsdom
// BDD: workbench-missing-commands §1 —— VSCode 的附加默认键:⇧⌘[ / ⇧⌘](上 / 下一个编辑器,mac)、⌃⇧`(新建终端)、F1(显示所有命令)。
import { describe, expect, it } from 'vitest';
import { editorCommandSpecs, NEXT_EDITOR_COMMAND_ID, PREVIOUS_EDITOR_COMMAND_ID } from '@/panels/Editor/editor-commands';
import { windowCommandSpecs } from '@/shell/window-commands';
import { TERMINAL_NEW_COMMAND, terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import { winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
const noRegistry = { getAll: () => [] as CommandSpec[] };

describe('上 / 下一个编辑器:mac 另有 ⇧⌘[ / ⇧⌘]', () => {
  const byId = (platform: 'mac' | 'other', id: string) => editorCommandSpecs(platform).find((c) => c.id === id)!;

  it('mac:主键 ⌥⌘← / ⌥⌘→,附加默认键 ⇧⌘[ / ⇧⌘];Windows / Linux 无附加键', () => {
    expect(byId('mac', NEXT_EDITOR_COMMAND_ID)).toMatchObject({ hotkey: 'mod+alt+right', secondaryHotkeys: ['mod+shift+]'] });
    expect(byId('mac', PREVIOUS_EDITOR_COMMAND_ID)).toMatchObject({ hotkey: 'mod+alt+left', secondaryHotkeys: ['mod+shift+['] });
    expect(byId('other', NEXT_EDITOR_COMMAND_ID).secondaryHotkeys).toBeUndefined();
  });

  it('mac 按 ⇧⌘](e.key 为上档字符 })→ 胜出的是下一个编辑器;⇧⌘[ → 上一个', () => {
    const specs = editorCommandSpecs('mac');
    const next = key({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    const prev = key({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true });
    expect(winningCommandFor(next, specs, 'mac', {})?.id).toBe(NEXT_EDITOR_COMMAND_ID);
    expect(winningCommandFor(prev, specs, 'mac', {})?.id).toBe(PREVIOUS_EDITOR_COMMAND_ID);
  });
});

describe('新建终端:附加默认键 ⌃⇧`', () => {
  it('主键 ⌘T 不变,附加 ⌃⇧`;焦点在终端时按 ⌃⇧` 让出给新建终端(不发给 shell)', () => {
    expect(TERMINAL_NEW_COMMAND).toMatchObject({ id: 'terminal.new', hotkey: 'mod+t', secondaryHotkeys: ['ctrl+shift+`'] });
    const e = key({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true });
    expect(terminalYieldedCommandId(e, 'mac', {}, noRegistry)).toBe('terminal.new');
    expect(terminalYieldedCommandId(e, 'other', {}, noRegistry)).toBe('terminal.new');
  });
});

describe('显示所有命令:附加默认键 F1', () => {
  it('注册的命令带 F1;终端里按 F1 让出给它', () => {
    const show = windowCommandSpecs().find((c) => c.id === 'workbench.action.showCommands')!;
    expect(show.secondaryHotkeys).toEqual(['f1']);
    const e = key({ key: 'F1', code: 'F1' });
    expect(terminalYieldedCommandId(e, 'mac', {}, noRegistry)).toBe('workbench.action.showCommands');
  });
});
