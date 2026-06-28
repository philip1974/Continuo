// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useQuickOpenHotkey } from '../../plugins/quick-open/useQuickOpenHotkey';
import { useQuickOpenStore } from '../../plugins/quick-open/store';

function Probe() {
  useQuickOpenHotkey();
  return null;
}

const origPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
function setPlatform(p: string) {
  Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  setPlatform('MacIntel');
  useQuickOpenStore.setState({
    isOpen: false,
    query: '',
    selectedIndex: 0,
    results: [],
    resultsRoot: null,
    loading: false,
    scanFailed: false,
  });
});

afterEach(() => {
  cleanup();
  if (origPlatform) Object.defineProperty(navigator, 'platform', origPlatform);
});

describe('useQuickOpenHotkey', () => {
  it('Meta+P 大写 key 不调用 toLowerCase 也能打开', () => {
    render(<Probe />);
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');
    try {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'P', metaKey: true }),
      );
      expect(useQuickOpenStore.getState().isOpen).toBe(true);
      expect(lowerSpy).not.toHaveBeenCalled();
    } finally {
      lowerSpy.mockRestore();
    }
  });

  it('Meta+Shift+P 留给 Command Palette,不触发 Quick Open', () => {
    render(<Probe />);
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'P',
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
  });
});
