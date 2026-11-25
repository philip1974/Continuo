// BDD: format-hotkey
// 纯函数 formatHotkey + detectPlatform 行为契约。

import { describe, it, expect, vi } from 'vitest';
import {
  formatHotkey,
  formatHotkeyParts,
  detectPlatform,
  canonicalHotkey,
} from '../../plugins/command-palette/format-hotkey';

// ────────────────────────────────────────────────────────────
// formatHotkey · mac 紧凑形式
// ────────────────────────────────────────────────────────────

describe('formatHotkey · mac', () => {
  it.each<[string, string]>([
    ['mod+s', '⌘S'],
    ['mod+,', '⌘,'],
    ['mod+shift+h', '⇧⌘H'],
    ['mod+shift+p', '⇧⌘P'],
    ['mod+alt+l', '⌥⌘L'],
    ['mod+ctrl+space', '⌃⌘␣'],
    ['shift+enter', '⇧↵'],
    ['mod+/', '⌘/'],
    ['mod+.', '⌘.'],
  ])('"%s" → "%s"', (raw, expected) => {
    expect(formatHotkey(raw, 'mac')).toBe(expected);
  });

  it.each<[string, string]>([
    ['enter', '↵'],
    ['escape', '⎋'],
    ['esc', '⎋'],
    ['space', '␣'],
    ['tab', '⇥'],
    ['backspace', '⌫'],
    ['delete', '⌦'],
    ['del', '⌦'],
    ['up', '↑'],
    ['down', '↓'],
    ['left', '←'],
    ['right', '→'],
    ['pageup', '⇞'],
    ['pagedown', '⇟'],
  ])('特殊键 "%s" → "%s"', (raw, expected) => {
    expect(formatHotkey(raw, 'mac')).toBe(expected);
  });
});

// ────────────────────────────────────────────────────────────
// formatHotkey · other(Win/Linux)文字 + 分隔
// ────────────────────────────────────────────────────────────

describe('formatHotkey · other', () => {
  it.each<[string, string]>([
    ['mod+s', 'Ctrl+S'],
    ['mod+,', 'Ctrl+,'],
    ['mod+shift+h', 'Ctrl+Shift+H'],
    ['mod+shift+p', 'Ctrl+Shift+P'],
    ['mod+alt+l', 'Ctrl+Alt+L'],
    ['shift+enter', 'Shift+Enter'],
  ])('"%s" → "%s"', (raw, expected) => {
    expect(formatHotkey(raw, 'other')).toBe(expected);
  });

  it.each<[string, string]>([
    ['enter', 'Enter'],
    ['escape', 'Esc'],
    ['space', 'Space'],
    ['tab', 'Tab'],
    ['backspace', 'Backspace'],
    ['delete', 'Del'],
    ['up', '↑'],
    ['down', '↓'],
    ['pageup', 'PageUp'],
    ['pagedown', 'PageDown'],
    ['ctrl+pagedown', 'Ctrl+PageDown'],
  ])('特殊键 "%s" → "%s"', (raw, expected) => {
    expect(formatHotkey(raw, 'other')).toBe(expected);
  });
});

// ────────────────────────────────────────────────────────────
// 大小写不敏感
// ────────────────────────────────────────────────────────────

describe('formatHotkey · 大小写不敏感', () => {
  it('Mod+Shift+H = MOD+SHIFT+H = mod+shift+h', () => {
    expect(formatHotkey('Mod+Shift+H', 'mac')).toBe('⇧⌘H');
    expect(formatHotkey('MOD+SHIFT+H', 'mac')).toBe('⇧⌘H');
    expect(formatHotkey('mod+shift+h', 'mac')).toBe('⇧⌘H');
  });

  it('option 等价 alt(mac 习惯名)', () => {
    expect(formatHotkey('mod+option+l', 'mac')).toBe('⌥⌘L');
    expect(formatHotkey('mod+option+l', 'other')).toBe('Ctrl+Alt+L');
  });

  it('return 等价 enter', () => {
    expect(formatHotkey('mod+return', 'mac')).toBe('⌘↵');
  });
});

// ────────────────────────────────────────────────────────────
// 修饰键固定显示顺序(与注册段序无关)
// mac ⌃⌥⇧⌘(Apple HIG / VSCode 同序);其它 Ctrl+Alt+Shift+Win
// ────────────────────────────────────────────────────────────

describe('formatHotkey · 修饰键固定顺序', () => {
  it('段序不同的同一组合显示一致(Toggle Terminal Zoom shift+mod+enter 与 New Window mod+shift+n 同序)', () => {
    expect(formatHotkey('shift+mod+enter', 'mac')).toBe('⇧⌘↵');
    expect(formatHotkey('mod+shift+enter', 'mac')).toBe('⇧⌘↵');
    expect(formatHotkey('mod+shift+n', 'mac')).toBe('⇧⌘N');
    expect(formatHotkey('shift+mod+enter', 'other')).toBe('Ctrl+Shift+Enter');
    expect(formatHotkeyParts('shift+mod+enter', 'mac')).toEqual(['⇧', '⌘', '↵']);
    expect(formatHotkeyParts('shift+mod+enter', 'other')).toEqual(['Ctrl', 'Shift', 'Enter']);
  });

  it('四修饰键全序:mac ⌃⌥⇧⌘,其它 Ctrl+Alt+Shift+Win', () => {
    expect(formatHotkey('cmd+shift+alt+ctrl+k', 'mac')).toBe('⌃⌥⇧⌘K');
    expect(formatHotkey('cmd+shift+option+ctrl+k', 'other')).toBe('Ctrl+Alt+Shift+Win+K');
    expect(formatHotkey('alt+mod+left', 'mac')).toBe('⌥⌘←');
    expect(formatHotkey('alt+mod+left', 'other')).toBe('Ctrl+Alt+←');
  });

  it('同义修饰键去重(其它平台 mod≡ctrl、mac mod≡cmd)', () => {
    expect(formatHotkey('ctrl+mod+x', 'other')).toBe('Ctrl+X');
    expect(formatHotkey('cmd+mod+x', 'mac')).toBe('⌘X');
  });

  it('含未知修饰段时按原段序显示(不猜测)', () => {
    expect(formatHotkey('hyper+shift+x', 'other')).toBe('HYPER+Shift+X');
  });
});

// ────────────────────────────────────────────────────────────
// 边界
// ────────────────────────────────────────────────────────────

describe('formatHotkey · 边界', () => {
  it('空字符串 → 空字符串', () => {
    expect(formatHotkey('', 'mac')).toBe('');
    expect(formatHotkey('', 'other')).toBe('');
  });

  it('单键无修饰', () => {
    expect(formatHotkey('a', 'mac')).toBe('A');
    expect(formatHotkey('a', 'other')).toBe('A');
    expect(formatHotkey('escape', 'mac')).toBe('⎋');
  });

  it('未知键名 uppercase 透传(F-keys 等)', () => {
    expect(formatHotkey('f1', 'mac')).toBe('F1');
    expect(formatHotkey('mod+f12', 'mac')).toBe('⌘F12');
    expect(formatHotkey('mod+f12', 'other')).toBe('Ctrl+F12');
  });

  it('多余 + 分隔符不报错', () => {
    expect(formatHotkey('mod++s', 'mac')).toBe('⌘S'); // 跳空段
  });
});

// ────────────────────────────────────────────────────────────
// detectPlatform
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// formatHotkeyParts(给 KeyCap 渲染用)
// ────────────────────────────────────────────────────────────

describe('formatHotkeyParts', () => {
  it('常见小写 hotkey token 不调用 toLowerCase', () => {
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');

    try {
      expect(formatHotkeyParts('mod+shift+h', 'other')).toEqual([
        'Ctrl',
        'Shift',
        'H',
      ]);
      expect(formatHotkey('mod+enter', 'mac')).toBe('⌘↵');
      expect(
        lowerSpy.mock.contexts.some((ctx) =>
          ['mod', 'shift', 'h', 'enter'].includes(String(ctx)),
        ),
      ).toBe(false);
      expect(formatHotkey('MOD+SHIFT+H', 'mac')).toBe('⇧⌘H');
    } finally {
      lowerSpy.mockRestore();
    }
  });

  it('解析 parts 不通过 split/filter/map 物化中间数组', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');

    try {
      expect(formatHotkeyParts('mod+shift+h', 'other')).toEqual([
        'Ctrl',
        'Shift',
        'H',
      ]);
      expect(splitSpy).not.toHaveBeenCalled();
      expect(formatHotkeyParts.toString()).not.toContain('parts.push(');
    } finally {
      splitSpy.mockRestore();
    }
  });

  it.each<[string, 'mac' | 'other', string[]]>([
    ['mod+s', 'mac', ['⌘', 'S']],
    ['mod+s', 'other', ['Ctrl', 'S']],
    ['mod+shift+h', 'mac', ['⇧', '⌘', 'H']],
    ['mod+shift+h', 'other', ['Ctrl', 'Shift', 'H']],
    ['mod+,', 'mac', ['⌘', ',']],
    ['mod+,', 'other', ['Ctrl', ',']],
    ['escape', 'mac', ['⎋']],
    ['escape', 'other', ['Esc']],
    ['', 'mac', []],
    ['', 'other', []],
  ])('"%s" platform=%s → %j', (raw, platform, expected) => {
    expect(formatHotkeyParts(raw, platform)).toEqual(expected);
  });

  it('空结果复用稳定空 parts 数组', () => {
    expect(formatHotkeyParts('', 'mac')).toBe(formatHotkeyParts('', 'other'));
    expect(formatHotkeyParts('++', 'mac')).toEqual([]);
    expect(formatHotkeyParts('++', 'mac')).toBe(formatHotkeyParts('', 'mac'));
  });

  it('formatHotkey 是 formatHotkeyParts 的字符串 join 版', () => {
    const parts = formatHotkeyParts('mod+shift+h', 'mac');
    expect(parts.join('')).toBe(formatHotkey('mod+shift+h', 'mac'));
    const partsOther = formatHotkeyParts('mod+shift+h', 'other');
    expect(partsOther.join('+')).toBe(formatHotkey('mod+shift+h', 'other'));
  });
});

describe('canonicalHotkey · 冲突比较归一', () => {
  it('修饰键顺序无关、去重、大小写不敏感,主键别名归一', () => {
    expect(canonicalHotkey('shift+mod+enter', 'mac')).toBe(
      canonicalHotkey('mod+shift+return', 'mac'),
    );
    expect(canonicalHotkey('Shift+shift+Mod+X', 'other')).toBe(
      canonicalHotkey('mod+shift+x', 'other'),
    );
  });

  it('修饰键别名按运行时语义归一:option≡alt;mod 在 mac≡cmd、其它平台≡ctrl', () => {
    expect(canonicalHotkey('option+x', 'mac')).toBe(canonicalHotkey('alt+x', 'mac'));
    expect(canonicalHotkey('mod+x', 'mac')).toBe(canonicalHotkey('cmd+x', 'mac'));
    expect(canonicalHotkey('mod+x', 'mac')).not.toBe(canonicalHotkey('ctrl+x', 'mac'));
    expect(canonicalHotkey('mod+x', 'other')).toBe(canonicalHotkey('ctrl+x', 'other'));
    expect(canonicalHotkey('mod+x', 'other')).not.toBe(canonicalHotkey('cmd+x', 'other'));
  });
});

describe('detectPlatform', () => {
  it('返回 "mac" 或 "other"', () => {
    const p = detectPlatform();
    expect(p === 'mac' || p === 'other').toBe(true);
  });

  it('jsdom 环境(navigator.platform 通常空)→ other,不抛', () => {
    expect(() => detectPlatform()).not.toThrow();
  });

  it('Mac 平台检测不调用 RegExp.test', () => {
    const platformDesc = Object.getOwnPropertyDescriptor(navigator, 'platform');
    const userAgentDesc = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    const testSpy = vi.spyOn(RegExp.prototype, 'test');

    try {
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        configurable: true,
      });
      Object.defineProperty(navigator, 'userAgent', {
        value: '',
        configurable: true,
      });
      expect(detectPlatform()).toBe('mac');

      Object.defineProperty(navigator, 'platform', {
        value: '',
        configurable: true,
      });
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone)',
        configurable: true,
      });
      expect(detectPlatform()).toBe('mac');

      const applePlatformRegexCalls = testSpy.mock.contexts.filter(
        (context) => context instanceof RegExp && context.source === 'Mac|iPhone|iPad|iPod',
      );
      expect(applePlatformRegexCalls).toHaveLength(0);
    } finally {
      testSpy.mockRestore();
      if (platformDesc) Object.defineProperty(navigator, 'platform', platformDesc);
      if (userAgentDesc) Object.defineProperty(navigator, 'userAgent', userAgentDesc);
    }
  });
});

// 小键盘键显示 VSCode 的 UI 标签(NumPad1 / NumPad_Multiply …),与主键盘 1 / * 区分;Space 别名 spacebar 归一。
describe('formatHotkey · 小键盘与 Space 别名', () => {
  it.each<[string, 'mac' | 'other', string]>([
    ['mod+shift+numpad_multiply', 'mac', '⇧⌘NumPad_Multiply'],
    ['mod+numpad1', 'mac', '⌘NumPad1'],
    ['mod+numpad_add', 'other', 'Ctrl+NumPad_Add'],
    ['alt+numpad_subtract', 'other', 'Alt+NumPad_Subtract'],
    ['numpad_decimal', 'other', 'NumPad_Decimal'],
    ['numpad_divide', 'mac', 'NumPad_Divide'],
    ['ctrl+spacebar', 'mac', '⌃␣'],
  ])('"%s"(%s)→ "%s"', (raw, platform, expected) => {
    expect(formatHotkey(raw, platform)).toBe(expected);
  });

  it('含 shift 的小键盘键不做上档归一(numpad_multiply ≠ 8)', () => {
    expect(canonicalHotkey('mod+shift+numpad_multiply', 'mac')).toBe('meta+shift+numpad_multiply');
    expect(canonicalHotkey('mod+shift+*', 'mac')).toBe('meta+shift+8');
  });

  it('spacebar 与 space 视为同一个键', () => {
    expect(canonicalHotkey('ctrl+spacebar', 'mac')).toBe(canonicalHotkey('ctrl+space', 'mac'));
  });
});
