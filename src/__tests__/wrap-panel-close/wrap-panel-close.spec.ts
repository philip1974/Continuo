// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { wrapPanelClose } from '../../shell/dock/wrap-panel-close';
import { useClosingStore } from '../../stores/closing.store';
import { EXIT_DURATION_MS } from '../../shell/motion/tokens';

interface FakePanel {
  api: {
    id: string;
    close: () => void;
  };
}

function makePanel(id: string, close: () => void = vi.fn()): FakePanel {
  return { api: { id, close } };
}

describe('wrapPanelClose', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 清空 closing-store
    useClosingStore.setState({ ids: new Set() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('首次 close → 立即 mark + 延迟到 EXIT_DURATION_MS 后真 close', () => {
    const realClose = vi.fn();
    const panel = makePanel('p1', realClose);

    wrapPanelClose(panel as never);
    panel.api.close();

    // 立刻 mark
    expect(useClosingStore.getState().ids.has('p1')).toBe(true);
    // 真 close 还没调
    expect(realClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(EXIT_DURATION_MS - 1);
    expect(realClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(realClose).toHaveBeenCalledTimes(1);
  });

  it('同 panel 二次 close(动画期内) → 不重复 mark / setTimeout', () => {
    const realClose = vi.fn();
    const panel = makePanel('p2', realClose);

    wrapPanelClose(panel as never);
    panel.api.close();
    panel.api.close();
    panel.api.close();

    vi.advanceTimersByTime(EXIT_DURATION_MS);
    expect(realClose).toHaveBeenCalledTimes(1);
  });

  it('包裹幂等:同 panel 二次 wrap 不重复 defineProperty', () => {
    const realClose = vi.fn();
    const panel = makePanel('p3', realClose);

    wrapPanelClose(panel as never);
    const wrappedAfterFirst = panel.api.close;

    wrapPanelClose(panel as never);
    expect(panel.api.close).toBe(wrappedAfterFirst);

    panel.api.close();
    vi.advanceTimersByTime(EXIT_DURATION_MS);
    expect(realClose).toHaveBeenCalledTimes(1);
  });

  it('真 close 抛错时 catch 静默', () => {
    const realClose = vi.fn(() => {
      throw new Error('panel already detached');
    });
    const panel = makePanel('p4', realClose);

    wrapPanelClose(panel as never);

    expect(() => {
      panel.api.close();
      vi.advanceTimersByTime(EXIT_DURATION_MS);
    }).not.toThrow();
    expect(realClose).toHaveBeenCalledTimes(1);
  });

  it('不同 panel 互不干扰', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const a = makePanel('a', closeA);
    const b = makePanel('b', closeB);

    wrapPanelClose(a as never);
    wrapPanelClose(b as never);

    a.api.close();
    expect(useClosingStore.getState().ids.has('a')).toBe(true);
    expect(useClosingStore.getState().ids.has('b')).toBe(false);

    b.api.close();
    expect(useClosingStore.getState().ids.has('b')).toBe(true);

    vi.advanceTimersByTime(EXIT_DURATION_MS);
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
  });
});
