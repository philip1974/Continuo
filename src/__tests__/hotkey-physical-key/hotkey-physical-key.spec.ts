// BDD:⌥ / ⇧ 组合按物理键取主键,录制与匹配同源。见同目录 README。
import { describe, expect, it } from 'vitest';
import { eventToCombo, selectKeybindingConflicts } from '../../plugins/keybindings/KeybindingCaptureModal';
import { matchesHotkey, winningCommandFor } from '../../plugins/command-palette/useCommandHotkeys';
import { eventHotkeyKey } from '../../plugins/command-palette/event-hotkey-key';
import type { CommandSpec } from '../../plugins/registries/CommandRegistry';

function ev(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent;
}

function spec(id: string, hotkey: string): CommandSpec {
  return { id, title: id, hotkey, fn: () => {} };
}

describe('录制:mac ⌥ / ⇧ 组合得到物理键', () => {
  it.each([
    [{ key: '˚', code: 'KeyK', altKey: true }, 'alt+k'],
    [{ key: 'Dead', code: 'KeyE', altKey: true }, 'alt+e'],
    [{ key: 'Dead', code: 'KeyU', altKey: true }, 'alt+u'],
    [{ key: 'Dead', code: 'KeyN', altKey: true }, 'alt+n'],
    [{ key: '!', code: 'Digit1', shiftKey: true }, 'shift+1'],
    [{ key: '?', code: 'Slash', shiftKey: true, metaKey: true }, 'mod+shift+/'],
    [{ key: '+', code: 'Equal', shiftKey: true, metaKey: true }, 'mod+shift+='],
    [{ key: '{', code: 'BracketLeft', shiftKey: true, metaKey: true }, 'mod+shift+['],
    [{ key: '–', code: 'Minus', altKey: true }, 'alt+-'],
    [{ key: '¬', code: 'KeyL', altKey: true, metaKey: true }, 'mod+alt+l'],
    [{ key: '¡', code: 'Digit1', altKey: true }, 'alt+1'],
  ])('%o → %s', (init, combo) => {
    expect(eventToCombo(ev(init), 'mac')).toBe(combo);
  });

  it('死键之间不再互相冲突', () => {
    const e = eventToCombo(ev({ key: 'Dead', code: 'KeyE', altKey: true }), 'mac');
    const u = eventToCombo(ev({ key: 'Dead', code: 'KeyU', altKey: true }), 'mac');
    expect(e).not.toBe(u);
  });

  it('⇧ + 字母仍是小写字母(不走物理键也一致)', () => {
    expect(eventToCombo(ev({ key: 'K', code: 'KeyK', shiftKey: true, metaKey: true }), 'mac')).toBe('mod+shift+k');
  });

  it('非 US 布局:无 ⌥ 的字母取布局字符(德语 QWERTZ 物理 Y 键产出 z)', () => {
    expect(eventToCombo(ev({ key: 'z', code: 'KeyY', metaKey: true }), 'mac')).toBe('mod+z');
  });

  it('非 US 布局:无 ⌥ 的非 ASCII 字符保留(德语 ü)', () => {
    expect(eventToCombo(ev({ key: 'ü', code: 'BracketLeft', metaKey: true }), 'mac')).toBe('mod+ü');
  });

  it('Windows Alt + 字母 e.key 本就是字母 → 不变', () => {
    expect(eventToCombo(ev({ key: 'k', code: 'KeyK', altKey: true, ctrlKey: true }), 'other')).toBe('mod+alt+k');
  });

  it('命名键不受影响', () => {
    expect(eventToCombo(ev({ key: 'ArrowRight', code: 'ArrowRight', altKey: true, metaKey: true }), 'mac')).toBe(
      'mod+alt+arrowright',
    );
    expect(eventHotkeyKey(ev({ key: 'F6', code: 'F6', shiftKey: true }))).toBe('f6');
  });

  it('e.code 不在映射表 → 退回 e.key', () => {
    expect(eventHotkeyKey(ev({ key: '§', code: 'IntlBackslash', shiftKey: true }))).toBe('§');
  });
});

describe('匹配:与录制同一个主键', () => {
  it.each([
    ['alt+k', { key: '˚', code: 'KeyK', altKey: true }],
    ['alt+e', { key: 'Dead', code: 'KeyE', altKey: true }],
    ['shift+1', { key: '!', code: 'Digit1', shiftKey: true }],
    ['mod+alt+l', { key: '¬', code: 'KeyL', altKey: true, metaKey: true }],
    ['mod+shift+=', { key: '+', code: 'Equal', shiftKey: true, metaKey: true }],
  ])('%s 被对应的 mac 按键触发', (combo, init) => {
    expect(matchesHotkey(combo, ev(init), 'mac')).toBe(true);
  });

  it('alt+e 不被 ⌥U 触发', () => {
    expect(matchesHotkey('alt+e', ev({ key: 'Dead', code: 'KeyU', altKey: true }), 'mac')).toBe(false);
  });
});

describe('兼容:旧写法照常生效', () => {
  it.each([
    ['mod+shift+?', { key: '?', code: 'Slash', shiftKey: true, metaKey: true }],
    ['shift+!', { key: '!', code: 'Digit1', shiftKey: true }],
    ['ctrl+shift+_', { key: '_', code: 'Minus', shiftKey: true, ctrlKey: true }],
  ])('上档符号旧值 %s 仍被触发', (combo, init) => {
    expect(matchesHotkey(combo, ev(init), 'mac')).toBe(true);
  });

  it('旧版录下的布局变形字符(alt+˚)仍按 e.key 兜底触发', () => {
    expect(matchesHotkey('alt+˚', ev({ key: '˚', code: 'KeyK', altKey: true }), 'mac')).toBe(true);
  });

  it('新主键优先于旧兜底:旧 alt+dead 在前也不抢新录的 alt+u', () => {
    const commands = [spec('legacy', 'alt+dead'), spec('fresh', 'alt+u')];
    const e = ev({ key: 'Dead', code: 'KeyU', altKey: true });
    expect(winningCommandFor(e, commands, 'mac', {})?.id).toBe('fresh');
    // 没有新写法时旧值兜底仍生效
    expect(winningCommandFor(e, [spec('legacy', 'alt+dead')], 'mac', {})?.id).toBe('legacy');
  });

  it('冲突检测:shift+/ 与旧值 shift+? 视为同一个键', () => {
    const commands = [spec('old', 'mod+shift+?'), spec('other', 'mod+shift+.')];
    expect(selectKeybindingConflicts(commands, 'me', 'mod+shift+/').map((c) => c.id)).toEqual(['old']);
  });
});

// Space(VSCode 键名 space):e.key 是空白(' ',mac ⌥Space 为不换行空格 U+00A0),此前录制被形态校验拒绝、
// 手写 ctrl+space 永不触发。归一为 space,录制与匹配同源。
describe('Space:录制与匹配统一为 space', () => {
  it.each([
    [{ key: ' ', code: 'Space', ctrlKey: true }, 'ctrl+space'],
    [{ key: ' ', code: 'Space', metaKey: true }, 'mod+space'],
    [{ key: ' ', code: 'Space', altKey: true }, 'alt+space'],
    [{ key: ' ', code: 'Space', shiftKey: true, metaKey: true }, 'mod+shift+space'],
  ])('mac %o → %s', (init, combo) => {
    expect(eventToCombo(ev(init), 'mac')).toBe(combo);
    expect(matchesHotkey(combo, ev(init), 'mac')).toBe(true);
  });

  it('缺 e.code 的合成事件按 e.key 空白同样归一', () => {
    expect(eventHotkeyKey(ev({ key: ' ', ctrlKey: true }))).toBe('space');
  });

  it('手写 ctrl+space 被 ⌃Space 触发', () => {
    expect(matchesHotkey('ctrl+space', ev({ key: ' ', code: 'Space', ctrlKey: true }), 'mac')).toBe(true);
    expect(matchesHotkey('mod+space', ev({ key: ' ', code: 'Space', ctrlKey: true }), 'other')).toBe(true);
  });

  it('单独 Space(无修饰)可录(VSCode 录键框同样可录任意键);运行时在输入框内不拦截(见 A64)', () => {
    expect(eventToCombo(ev({ key: ' ', code: 'Space' }), 'mac')).toBe('space');
  });
});

// 小键盘(VSCode 键名 numpad0…numpad9 / numpad_multiply / numpad_add / numpad_subtract / numpad_decimal /
// numpad_divide):与主键盘区是不同的键。此前 ⇧⌘ 小键盘 * 录成 mod+shift+*,编译时上档归一成 8、运行时主键仍是 *
// → 永不触发且被误判与 ⇧⌘8 冲突;⌘Numpad1 录成 mod+1。
describe('小键盘:按 VSCode numpad 键名录制与匹配,与主键盘区分', () => {
  it.each([
    [{ key: '*', code: 'NumpadMultiply', shiftKey: true, metaKey: true }, 'mod+shift+numpad_multiply'],
    [{ key: '+', code: 'NumpadAdd', metaKey: true }, 'mod+numpad_add'],
    [{ key: '-', code: 'NumpadSubtract', metaKey: true }, 'mod+numpad_subtract'],
    [{ key: '.', code: 'NumpadDecimal', metaKey: true }, 'mod+numpad_decimal'],
    [{ key: '/', code: 'NumpadDivide', metaKey: true }, 'mod+numpad_divide'],
    [{ key: '1', code: 'Numpad1', metaKey: true }, 'mod+numpad1'],
    [{ key: '0', code: 'Numpad0', altKey: true }, 'alt+numpad0'],
  ])('%o → %s,且被同一按键触发', (init, combo) => {
    expect(eventToCombo(ev(init), 'mac')).toBe(combo);
    expect(matchesHotkey(combo, ev(init), 'mac')).toBe(true);
  });

  it('⇧⌘ 小键盘 * 不与 ⇧⌘8 冲突,也不被 ⇧⌘8 触发', () => {
    const commands = [spec('eight', 'mod+shift+8')];
    expect(selectKeybindingConflicts(commands, 'me', 'mod+shift+numpad_multiply')).toEqual([]);
    expect(
      matchesHotkey('mod+shift+numpad_multiply', ev({ key: '*', code: 'Digit8', shiftKey: true, metaKey: true }), 'mac'),
    ).toBe(false);
  });

  it('⌘Numpad1 与 ⌘1 是不同的键(VSCode 同):互不触发', () => {
    expect(matchesHotkey('mod+1', ev({ key: '1', code: 'Numpad1', metaKey: true }), 'mac')).toBe(false);
    expect(matchesHotkey('mod+numpad1', ev({ key: '1', code: 'Digit1', metaKey: true }), 'mac')).toBe(false);
  });

  it('NumLock 关闭时小键盘产出的导航键(End / ArrowDown …)仍按命名键', () => {
    expect(eventHotkeyKey(ev({ key: 'End', code: 'Numpad1' }))).toBe('end');
  });
});
