// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useCommandPaletteHotkey } from '../../plugins/command-palette/useCommandPaletteHotkey';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';

function Probe() {
  useCommandPaletteHotkey();
  return null;
}

beforeEach(() => {
  useCommandPaletteStore.setState({
    isOpen: false,
    query: '',
    selectedIndex: 0,
  });
});
afterEach(() => cleanup());

describe('useCommandPaletteHotkey', () => {
  it('Meta+P 打开 palette', () => {
    render(<Probe />);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', metaKey: true }),
    );
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
  });

  it('Ctrl+P 同样打开(非 mac)', () => {
    render(<Probe />);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }),
    );
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
  });

  it('已 open 再按 → 关闭(toggle)', () => {
    render(<Probe />);
    useCommandPaletteStore.getState().open();
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
      new KeyboardEvent('keydown', { key: 'p', metaKey: true }),
    );
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });
});
