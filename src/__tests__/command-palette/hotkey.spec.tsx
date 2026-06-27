// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useCommandPaletteHotkey } from '../../plugins/command-palette/useCommandPaletteHotkey';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';

function Probe() {
  useCommandPaletteHotkey();
  return null;
}

// 平台感知:mac 用 Cmd(meta),非 mac 只认 Ctrl(避免 Win/Super 键误触发)。
// 测试需显式固定平台(jsdom 默认 navigator.platform 不确定)。
const origPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
function setPlatform(p: string) {
  Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  setPlatform('MacIntel'); // 默认 mac:Cmd 生效
  useCommandPaletteStore.setState({
    isOpen: false,
    query: '',
    selectedIndex: 0,
  });
});
afterEach(() => {
  cleanup();
  if (origPlatform) Object.defineProperty(navigator, 'platform', origPlatform);
});

describe('useCommandPaletteHotkey', () => {
  it('Meta+Shift+P 打开 palette(让位 ⌘P 给 Quick Open)', () => {
    render(<Probe />);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', metaKey: true, shiftKey: true }),
    );
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
  });

  it('Ctrl+Shift+P 同样打开(非 mac)', () => {
    setPlatform('Linux x86_64'); // 非 mac:Ctrl 是 mod
    render(<Probe />);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true }),
    );
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
  });

  it('非 mac:Meta(Super/Win)+Shift+P 不触发(跨平台审计 P2)', () => {
    setPlatform('Linux x86_64');
    render(<Probe />);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', metaKey: true, shiftKey: true }),
    );
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('已 open 再按 → 关闭(toggle)', () => {
    render(<Probe />);
    useCommandPaletteStore.getState().open();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', metaKey: true, shiftKey: true }),
    );
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('Meta+P 不带 shift → 不触发(留给 Quick Open)', () => {
    render(<Probe />);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', metaKey: true }),
    );
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('普通 P 不触发', () => {
    render(<Probe />);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('卸载组件 → 监听清理(再触发不响应)', () => {
    const { unmount } = render(<Probe />);
    unmount();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', metaKey: true, shiftKey: true }),
    );
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });
});
