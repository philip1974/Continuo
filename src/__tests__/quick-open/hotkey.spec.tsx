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

  // mac 上 Ctrl+P 是终端 readline 的「上一条历史」等 Control 序列;面板只认 Cmd,否则焦点在终端时
  // shell 收到按键的同时 Quick Open 也弹出来抢焦点。
  it('mac:Ctrl+P 不触发(留给终端 / 编辑器)', () => {
    render(<Probe />);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }));
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
  });

  it('非 mac:Ctrl+P 打开', () => {
    setPlatform('Linux x86_64');
    render(<Probe />);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }));
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
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
