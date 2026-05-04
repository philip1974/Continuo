// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { matchesHotkey } from '../../plugins/command-palette/useCommandHotkeys';

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
      matchesHotkey('mod+s', ev({ key: 's', ctrlKey: true })),
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
});
