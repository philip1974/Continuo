// @vitest-environment jsdom
// dockview splitview.layoutViews 对每个视图先写 style 再同步调 view.layout() → 同步派发
// onDidDimensionsChange。若此时同步 fit(addon-fit proposeDimensions 内 getComputedStyle 读刚写脏的
// 布局)= 强制同步回流,且多视图「写-读-写」交错。契约:dimensions 变化不同步 fit,合并到下一帧只
// request 一次;最终 fit 仍执行;卸载撤销未触发的帧。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  requestFit: vi.fn(),
  fit: vi.fn(),
  rafs: new Map<number, FrameRequestCallback>(),
  nextRaf: 1,
}));

vi.mock('../../panels/Terminal/useTerminal', () => ({
  useTerminal: () => ({
    containerRef: { current: null },
    isReady: true,
    fit: hoisted.fit,
    requestFit: hoisted.requestFit,
    focus: vi.fn(),
    searchApi: { open: vi.fn(), close: vi.fn(), isOpen: false },
  }),
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

function flushRafs() {
  const pending = [...hoisted.rafs.values()];
  hoisted.rafs.clear();
  for (const cb of pending) cb(0);
}

function setup() {
  let onDims: (() => void) | null = null;
  const props = {
    api: {
      id: 'panel-1',
      title: 't1',
      close: vi.fn(),
      setTitle: vi.fn(),
      onDidActiveChange: () => ({ dispose: vi.fn() }),
      onDidDimensionsChange: (cb: () => void) => {
        onDims = cb;
        return { dispose: vi.fn() };
      },
      onDidVisibilityChange: () => ({ dispose: vi.fn() }),
    },
    params: { sessionId: 't1' },
  } as unknown as Parameters<typeof TerminalPanelView>[0];
  const view = render(<TerminalPanelView {...props} />);
  flushRafs(); // 挂载时的初次 fit 帧
  hoisted.fit.mockClear();
  return { view, fireDims: () => onDims!() };
}

beforeEach(() => {
  hoisted.requestFit.mockClear();
  hoisted.fit.mockClear();
  hoisted.rafs.clear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = hoisted.nextRaf++;
    hoisted.rafs.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    hoisted.rafs.delete(id);
  });
  useTerminalStore.setState({
    sessions: [
      {
        id: 't1',
        title: 't1',
        cwd: '/',
        originHint: 'user',
        createdAt: 0,
        exitCode: null,
        ownerWindowId: 1,
      },
    ] as never,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('terminal resize · dockview dimensions 变化合并到下一帧', () => {
  it('dimensions 变化不同步 fit / request(避免 layoutViews 写-读交错强制回流)', () => {
    const { fireDims } = setup();
    fireDims();
    expect(hoisted.requestFit).not.toHaveBeenCalled();
    expect(hoisted.fit).not.toHaveBeenCalled();
  });

  it('同一帧内多次 dimensions 变化只在下一帧 request 一次(最终 fit 仍执行)', () => {
    const { fireDims } = setup();
    fireDims();
    fireDims();
    fireDims();
    flushRafs();
    expect(hoisted.requestFit).toHaveBeenCalledTimes(1);
    // 下一帧再变化 → 再排一帧
    fireDims();
    flushRafs();
    expect(hoisted.requestFit).toHaveBeenCalledTimes(2);
  });

  it('卸载撤销未触发的 dimensions 帧', () => {
    const { view, fireDims } = setup();
    fireDims();
    view.unmount();
    flushRafs();
    expect(hoisted.requestFit).not.toHaveBeenCalled();
  });
});
