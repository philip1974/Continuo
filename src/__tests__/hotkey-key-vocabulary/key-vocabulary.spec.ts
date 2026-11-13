// BDD:快捷键键名词汇在匹配与显示两处一致。见同目录 README。
import { describe, expect, it } from 'vitest';
import { matchesHotkey } from '../../plugins/command-palette/useCommandHotkeys';
import { formatHotkey } from '../../plugins/command-palette/format-hotkey';
import { selectKeybindingConflicts } from '../../plugins/keybindings/KeybindingCaptureModal';
import type { CommandSpec } from '../../plugins/registries/CommandRegistry';

function ev(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent;
}

describe('匹配:主键别名归一到 e.key 名', () => {
  it.each([
    ['mod+up', 'ArrowUp'],
    ['mod+down', 'ArrowDown'],
    ['mod+left', 'ArrowLeft'],
    ['mod+right', 'ArrowRight'],
    ['mod+esc', 'Escape'],
    ['mod+return', 'Enter'],
    ['mod+del', 'Delete'],
  ])('%s 匹配 e.key=%s', (combo, key) => {
    expect(matchesHotkey(combo, ev({ key, ctrlKey: true }), 'other')).toBe(true);
  });

  it.each([
    ['mod+arrowup', 'ArrowUp'],
    ['mod+escape', 'Escape'],
    ['mod+enter', 'Enter'],
    ['mod+delete', 'Delete'],
  ])('真实 e.key 名 %s 照常匹配', (combo, key) => {
    expect(matchesHotkey(combo, ev({ key, ctrlKey: true }), 'other')).toBe(true);
  });

  it('别名不串键:mod+up 不匹配 ArrowDown', () => {
    expect(matchesHotkey('mod+up', ev({ key: 'ArrowDown', ctrlKey: true }), 'other')).toBe(false);
  });
});

describe('冲突检测:别名与 e.key 名视为同一个键', () => {
  const commands = [
    { id: 'plugin.up', title: 'Up', hotkey: 'mod+up', fn: () => {} },
    { id: 'plugin.close', title: 'Close', hotkey: 'mod+esc', fn: () => {} },
    { id: 'plugin.other', title: 'Other', hotkey: 'mod+k', fn: () => {} },
  ] as readonly CommandSpec[];

  it('录制出 mod+arrowup 与已注册的 mod+up 冲突', () => {
    expect(selectKeybindingConflicts(commands, 'me', 'mod+arrowup').map((c) => c.id)).toEqual([
      'plugin.up',
    ]);
  });

  it('录制出 mod+escape 与已注册的 mod+esc 冲突', () => {
    expect(selectKeybindingConflicts(commands, 'me', 'mod+escape').map((c) => c.id)).toEqual([
      'plugin.close',
    ]);
  });

  it('不同键不误报', () => {
    expect(selectKeybindingConflicts(commands, 'me', 'mod+arrowdown')).toEqual([]);
  });
});

describe('显示:认真实 e.key 名与 cmd', () => {
  it('录制出的方向键名与别名显示相同', () => {
    expect(formatHotkey('mod+arrowup', 'other')).toBe(formatHotkey('mod+up', 'other'));
    expect(formatHotkey('mod+arrowleft', 'mac')).toBe(formatHotkey('mod+left', 'mac'));
    expect(formatHotkey('arrowdown', 'other')).not.toContain('ARROW');
  });

  it('cmd:mac 显示 ⌘,其它平台显示 Win', () => {
    expect(formatHotkey('cmd+k', 'mac')).toContain('⌘');
    expect(formatHotkey('cmd+k', 'other')).toContain('Win');
    expect(formatHotkey('cmd+k', 'other')).not.toContain('CMD');
  });
});
