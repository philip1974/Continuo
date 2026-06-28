// BDD: format-hotkey
// 纯函数 formatHotkey + detectPlatform 行为契约。

import { describe, it, expect, vi } from 'vitest';
import {
  formatHotkey,
  formatHotkeyParts,
  detectPlatform,
} from '../../plugins/command-palette/format-hotkey';

// ────────────────────────────────────────────────────────────
// formatHotkey · mac 紧凑形式
// ────────────────────────────────────────────────────────────

describe('formatHotkey · mac', () => {
  it.each<[string, string]>([
    ['mod+s', '⌘S'],
    ['mod+,', '⌘,'],
    ['mod+shift+h', '⌘⇧H'],
    ['mod+shift+p', '⌘⇧P'],
    ['mod+alt+l', '⌘⌥L'],
    ['mod+ctrl+space', '⌘⌃␣'],
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
  ])('特殊键 "%s" → "%s"', (raw, expected) => {
    expect(formatHotkey(raw, 'other')).toBe(expected);
  });
});

// ────────────────────────────────────────────────────────────
// 大小写不敏感
// ────────────────────────────────────────────────────────────

describe('formatHotkey · 大小写不敏感', () => {
  it('Mod+Shift+H = MOD+SHIFT+H = mod+shift+h', () => {
    expect(formatHotkey('Mod+Shift+H', 'mac')).toBe('⌘⇧H');
    expect(formatHotkey('MOD+SHIFT+H', 'mac')).toBe('⌘⇧H');
    expect(formatHotkey('mod+shift+h', 'mac')).toBe('⌘⇧H');
  });

  it('option 等价 alt(mac 习惯名)', () => {
    expect(formatHotkey('mod+option+l', 'mac')).toBe('⌘⌥L');
    expect(formatHotkey('mod+option+l', 'other')).toBe('Ctrl+Alt+L');
  });

  it('return 等价 enter', () => {
    expect(formatHotkey('mod+return', 'mac')).toBe('⌘↵');
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
      expect(formatHotkey('MOD+SHIFT+H', 'mac')).toBe('⌘⇧H');
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
    ['mod+shift+h', 'mac', ['⌘', '⇧', 'H']],
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
