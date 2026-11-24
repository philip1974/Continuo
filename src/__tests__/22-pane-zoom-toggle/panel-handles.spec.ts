// BDD: 22-pane-zoom-toggle / terminal-panel-handles
//
// 注册表把每个 terminal panel 的句柄 { focus, openSearch } 按 panelId 索引:
// - DockShell 在 onDidMaximizedGroupChange isMaximized=false 时显式调
//   focusTerminalPanel(group.activePanel.id) 拉回 xterm focus;
// - terminal.search.toggle command 经 openTerminalSearch(panelId) 打开搜索条。
//
// stale 安全:句柄内部用 termRef.current?.focus() optional chain,
// useTerminal unmount 时已置 null;dispose 删表后再调返回 false / no-op。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerTerminalPanelHandles,
  focusTerminalPanel,
  openTerminalSearch,
  __resetTerminalPanelHandlesForTest,
} from '@/panels/Terminal/terminal-panel-handles';

function handles() {
  return { focus: vi.fn(), openSearch: vi.fn(), clear: vi.fn(), readText: vi.fn(() => "") };
}

describe('terminal-panel-handles (T6b)', () => {
  beforeEach(() => {
    __resetTerminalPanelHandlesForTest();
  });

  it('register + focusTerminalPanel → focus 被调用 + 返回 true,openSearch 不受影响', () => {
    const h = handles();
    registerTerminalPanelHandles('terminal-abc', h);
    expect(focusTerminalPanel('terminal-abc')).toBe(true);
    expect(h.focus).toHaveBeenCalledTimes(1);
    expect(h.openSearch).not.toHaveBeenCalled();
  });

  it('register + openTerminalSearch → openSearch 被调用,focus 不受影响', () => {
    const h = handles();
    registerTerminalPanelHandles('terminal-abc', h);
    openTerminalSearch('terminal-abc');
    expect(h.openSearch).toHaveBeenCalledTimes(1);
    expect(h.focus).not.toHaveBeenCalled();
  });

  it('未注册 id → focusTerminalPanel 返回 false、openTerminalSearch no-op,均不 throw', () => {
    expect(() => focusTerminalPanel('terminal-unknown')).not.toThrow();
    expect(focusTerminalPanel('terminal-unknown')).toBe(false);
    expect(() => openTerminalSearch('terminal-unknown')).not.toThrow();
  });

  it('多个 panel 互不影响', () => {
    const a = handles();
    const b = handles();
    registerTerminalPanelHandles('terminal-a', a);
    registerTerminalPanelHandles('terminal-b', b);
    focusTerminalPanel('terminal-a');
    openTerminalSearch('terminal-b');
    expect(a.focus).toHaveBeenCalledTimes(1);
    expect(a.openSearch).not.toHaveBeenCalled();
    expect(b.focus).not.toHaveBeenCalled();
    expect(b.openSearch).toHaveBeenCalledTimes(1);
  });

  it('dispose 后 focus 返回 false、openSearch no-op,句柄不再被调 (P1-2 stale safe)', () => {
    const h = handles();
    const dispose = registerTerminalPanelHandles('terminal-x', h);
    dispose();
    expect(focusTerminalPanel('terminal-x')).toBe(false);
    openTerminalSearch('terminal-x');
    expect(h.focus).not.toHaveBeenCalled();
    expect(h.openSearch).not.toHaveBeenCalled();
  });

  it('register 同 id 二次覆盖最新句柄;旧 disposer 不误删新句柄', () => {
    const old = handles();
    const next = handles();
    const disposeOld = registerTerminalPanelHandles('terminal-dup', old);
    registerTerminalPanelHandles('terminal-dup', next);
    disposeOld();
    expect(focusTerminalPanel('terminal-dup')).toBe(true);
    openTerminalSearch('terminal-dup');
    expect(old.focus).not.toHaveBeenCalled();
    expect(old.openSearch).not.toHaveBeenCalled();
    expect(next.focus).toHaveBeenCalledTimes(1);
    expect(next.openSearch).toHaveBeenCalledTimes(1);
  });
});
