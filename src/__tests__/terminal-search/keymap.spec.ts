// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isSearchHotkey } from '@/panels/Terminal/terminal-search-keymap';

function setPlatform(platform: string): void {
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: platform,
  });
}

function key(init: Partial<KeyboardEventInit>): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'f',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  });
}

describe('isSearchHotkey', () => {
  it('S8 macOS accepts Cmd+F only', () => {
    setPlatform('MacIntel');

    expect(isSearchHotkey(key({ metaKey: true }))).toBe(true);
    expect(isSearchHotkey(key({ ctrlKey: true }))).toBe(false);
    expect(isSearchHotkey(key({ metaKey: true, shiftKey: true }))).toBe(false);
  });

  it('S8 Windows accepts Ctrl+F only', () => {
    setPlatform('Win32');

    expect(isSearchHotkey(key({ ctrlKey: true }))).toBe(true);
    expect(isSearchHotkey(key({ metaKey: true }))).toBe(false);
    expect(isSearchHotkey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('S8 Linux accepts Ctrl+F only', () => {
    setPlatform('Linux x86_64');

    expect(isSearchHotkey(key({ ctrlKey: true }))).toBe(true);
    expect(isSearchHotkey(key({ key: 'F', ctrlKey: true }))).toBe(true);
    expect(isSearchHotkey(key({}))).toBe(false);
  });

  it('S8 rejects f alone and shifted f', () => {
    setPlatform('MacIntel');

    expect(isSearchHotkey(key({}))).toBe(false);
    expect(isSearchHotkey(key({ key: 'F', shiftKey: true }))).toBe(false);
  });
});
