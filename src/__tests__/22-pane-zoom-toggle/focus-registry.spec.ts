// BDD: 22-pane-zoom-toggle / terminal-focus-registry
//
// 注册表把每个 terminal panel 的 focus() callback 按 panelId 索引,
// DockShell 在 onDidMaximizedGroupChange isMaximized=false 时显式调
// focusTerminalPanel(group.activePanel.id) 拉回 xterm focus。
//
// stale 安全:callback 内部用 termRef.current?.focus() optional chain,
// useTerminal unmount 时已置 null,unregister 删 map 再调返回 false。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerTerminalFocus,
  focusTerminalPanel,
  __resetTerminalFocusRegistryForTest,
} from '@/panels/Terminal/terminal-focus-registry';

describe('terminal-focus-registry (T6b)', () => {
  beforeEach(() => {
    __resetTerminalFocusRegistryForTest();
  });

  it('register + focusTerminalPanel → callback 被调用 + 返回 true', () => {
    const fn = vi.fn();
    registerTerminalFocus('terminal-abc', fn);
    expect(focusTerminalPanel('terminal-abc')).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('未注册 id → 返回 false 且不 throw', () => {
    expect(() => focusTerminalPanel('terminal-unknown')).not.toThrow();
    expect(focusTerminalPanel('terminal-unknown')).toBe(false);
  });

  it('多个 panel 互不影响', () => {
    const fnA = vi.fn();
    const fnB = vi.fn();
    registerTerminalFocus('terminal-a', fnA);
    registerTerminalFocus('terminal-b', fnB);
    focusTerminalPanel('terminal-a');
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).not.toHaveBeenCalled();
    focusTerminalPanel('terminal-b');
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('unregister 后 invoke 返回 false 且 callback 不再调 (P1-2 stale safe)', () => {
    const fn = vi.fn();
    const unregister = registerTerminalFocus('terminal-x', fn);
    unregister();
    expect(focusTerminalPanel('terminal-x')).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('register 同 id 二次覆盖最新 callback', () => {
    const fnOld = vi.fn();
    const fnNew = vi.fn();
    registerTerminalFocus('terminal-dup', fnOld);
    registerTerminalFocus('terminal-dup', fnNew);
    focusTerminalPanel('terminal-dup');
    expect(fnOld).not.toHaveBeenCalled();
    expect(fnNew).toHaveBeenCalledTimes(1);
  });
});
