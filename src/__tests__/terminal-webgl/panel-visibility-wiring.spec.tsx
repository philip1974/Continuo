// @vitest-environment jsdom
// BDD:终端面板把 dockview 显隐 / location 变化告知 WebGL 渲染器(切 tab 不卸载组件,只能靠事件),创建时询问的可见性取 api.isVisible。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  setRendererVisible: vi.fn(),
  options: null as null | { isVisible?: () => boolean },
}));

vi.mock('../../panels/Terminal/useTerminal', () => ({
  useTerminal: (_id: string, options: { isVisible?: () => boolean }) => {
    hoisted.options = options;
    return {
      containerRef: { current: null },
      isReady: true,
      fit: vi.fn(),
      requestFit: vi.fn(),
      focus: vi.fn(),
      setRendererVisible: hoisted.setRendererVisible,
      searchApi: { open: vi.fn(), close: vi.fn(), isOpen: false },
      contextMenuActions: {
        hasSelection: () => false,
        copy: vi.fn(),
        paste: vi.fn(),
        selectAll: vi.fn(),
        clear: vi.fn(),
        focus: vi.fn(),
      },
    };
  },
}));
vi.mock('../../panels/Terminal/useTerminalDragDrop', () => ({
  useTerminalDragDrop: () => ({ ref: { current: null } }),
}));
vi.mock('../../panels/Terminal/terminal-panel-handles', () => ({
  registerTerminalPanelHandles: () => vi.fn(),
}));
vi.mock('../../panels/Terminal/TerminalSearchBar', () => ({
  TerminalSearchBar: () => null,
}));

import { TerminalPanelView } from '../../panels/Terminal/TerminalPanelView';
import { useTerminalStore } from '../../stores/terminal.store';

beforeEach(() => {
  hoisted.setRendererVisible.mockClear();
  useTerminalStore.setState({
    sessions: [
      { id: 't1', title: 't1', cwd: '/', originHint: 'user', createdAt: 0, exitCode: null, ownerWindowId: 1 },
    ] as never,
  });
});
afterEach(() => cleanup());

describe('终端面板显隐 → WebGL 渲染器', () => {
  it('onDidVisibilityChange 转给 setRendererVisible;location 变化(进出 popout)落定后按当前可见性告知;创建时可见性读 api.isVisible', async () => {
    let onVisibility: ((e: { isVisible: boolean }) => void) | null = null;
    let onLocation: (() => void) | null = null;
    const api = {
      id: 'panel-1',
      title: 't1',
      isVisible: false,
      isActive: false,
      close: vi.fn(),
      setTitle: vi.fn(),
      onDidActiveChange: () => ({ dispose: vi.fn() }),
      onDidDimensionsChange: () => ({ dispose: vi.fn() }),
      onDidVisibilityChange: (cb: (e: { isVisible: boolean }) => void) => {
        onVisibility = cb;
        return { dispose: vi.fn() };
      },
      onDidLocationChange: (cb: () => void) => {
        onLocation = cb;
        return { dispose: vi.fn() };
      },
    };
    render(<TerminalPanelView {...({ api, params: { sessionId: 't1' } } as unknown as Parameters<typeof TerminalPanelView>[0])} />);
    expect(hoisted.options?.isVisible?.()).toBe(false);
    api.isVisible = true;
    expect(hoisted.options?.isVisible?.()).toBe(true);

    onVisibility!({ isVisible: false });
    expect(hoisted.setRendererVisible).toHaveBeenLastCalledWith(false);
    onVisibility!({ isVisible: true });
    expect(hoisted.setRendererVisible).toHaveBeenLastCalledWith(true);

    hoisted.setRendererVisible.mockClear();
    onLocation!();
    expect(hoisted.setRendererVisible).not.toHaveBeenCalled(); // 等 location 落定(微任务)
    await Promise.resolve();
    expect(hoisted.setRendererVisible).toHaveBeenCalledWith(true);
    hoisted.setRendererVisible.mockClear();
    api.isVisible = false;
    onLocation!();
    await Promise.resolve();
    expect(hoisted.setRendererVisible).not.toHaveBeenCalled();
  });
});
