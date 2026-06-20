// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { matchesHotkey as matchesHotkeyRaw } from '../../plugins/command-palette/useCommandHotkeys';
import type { Platform } from '../../plugins/command-palette/format-hotkey';

// R15:matchesHotkey 现在平台感知。这些用例多用 metaKey 测 mod = mac 行为,默认传 'mac';
// 「其它平台 mod=ctrl」的用例显式传 'other'。
function matchesHotkey(
  combo: string,
  e: KeyboardEvent,
  platform: Platform = 'mac',
): boolean {
  return matchesHotkeyRaw(combo, e, platform);
}

function ev(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: opts.key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
  });
}

describe('matchesHotkey', () => {
  it('mod+shift+h 匹配 metaKey + shift + h', () => {
    expect(
      matchesHotkey('mod+shift+h', ev({ key: 'h', metaKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it('mod 匹配 ctrlKey(其它平台)', () => {
    expect(
      matchesHotkey('mod+s', ev({ key: 's', ctrlKey: true }), 'other'),
    ).toBe(true);
  });

  it('cmd 别名同 mod', () => {
    expect(matchesHotkey('cmd+s', ev({ key: 's', metaKey: true }))).toBe(true);
  });

  it('shift 缺一边不匹配', () => {
    expect(
      matchesHotkey('mod+shift+h', ev({ key: 'h', metaKey: true })),
    ).toBe(false);
  });

  it('alt 多按一个不匹配', () => {
    expect(
      matchesHotkey(
        'mod+s',
        ev({ key: 's', metaKey: true, altKey: true }),
      ),
    ).toBe(false);
  });

  it('key 大小写不敏感', () => {
    expect(matchesHotkey('mod+H', ev({ key: 'h', metaKey: true }))).toBe(true);
    expect(matchesHotkey('mod+h', ev({ key: 'H', metaKey: true }))).toBe(true);
  });

  it('错 key 不匹配', () => {
    expect(matchesHotkey('mod+s', ev({ key: 'a', metaKey: true }))).toBe(false);
  });

  it('裸键无 mod 也能匹配', () => {
    expect(matchesHotkey('escape', ev({ key: 'Escape' }))).toBe(true);
  });

  it('裸键 + 多按 mod → 不匹配', () => {
    expect(matchesHotkey('escape', ev({ key: 'Escape', metaKey: true }))).toBe(
      false,
    );
  });

  it('mod+, 匹配 metaKey + 逗号(打开 Settings 用)', () => {
    expect(matchesHotkey('mod+,', ev({ key: ',', metaKey: true }))).toBe(true);
  });

  it('mod+, 不匹配带 shift(避免与 < 撞键)', () => {
    expect(
      matchesHotkey('mod+,', ev({ key: ',', metaKey: true, shiftKey: true })),
    ).toBe(false);
  });
});
