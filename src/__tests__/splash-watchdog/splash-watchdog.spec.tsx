// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';

const { breadcrumb, openLogsDir, relaunch } = vi.hoisted(() => ({
  breadcrumb: vi.fn(),
  openLogsDir: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  relaunch: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
}));

vi.mock('../../lib/diagnostics/breadcrumb', () => ({
  breadcrumb,
  probeCssLoaded: () => true,
}));

vi.mock('../../lib/co-api', () => ({
  coApi: {
    shell: { openLogsDir },
    app: { relaunch },
  },
  _resetLmApiForTest: () => {},
}));

// 必须在 mock 注册后再 import 被测组件
import { SplashWatchdog } from '../../shell/decor/SplashWatchdog';

beforeEach(() => {
  vi.useFakeTimers();
  openLogsDir.mockClear();
  relaunch.mockClear();
  breadcrumb.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function snapshot() {
  return {
    layoutReady: false,
    workspaceRoot: null as string | null,
    sidebarOpen: true,
    hasCoApi: true,
    cssLoaded: true,
  };
}

describe('SplashWatchdog — 计时', () => {
  it('layoutReady=false mount,500ms 内不渲染 Modal', () => {
    const forceEnter = vi.fn();
    render(
      <SplashWatchdog
        layoutReady={false}
        forceEnter={forceEnter}
        snapshot={snapshot}
        deadlineMs={3000}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.querySelector('.wm-modal-content')).toBeNull();
  });

  it('layoutReady=false mount,3100ms 后渲染 Modal', () => {
    render(
      <SplashWatchdog
        layoutReady={false}
        forceEnter={vi.fn()}
        snapshot={snapshot}
        deadlineMs={3000}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(document.querySelector('.wm-modal-content')).not.toBeNull();
  });

  it('layoutReady=true mount,从未渲染 Modal', () => {
    render(
      <SplashWatchdog
        layoutReady={true}
        forceEnter={vi.fn()}
        snapshot={snapshot}
        deadlineMs={3000}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(document.querySelector('.wm-modal-content')).toBeNull();
  });

  it('mount 时 false,deadline 前翻 true → Modal 永不渲染', () => {
    const { rerender } = render(
      <SplashWatchdog
        layoutReady={false}
        forceEnter={vi.fn()}
        snapshot={snapshot}
        deadlineMs={3000}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    rerender(
      <SplashWatchdog
        layoutReady={true}
        forceEnter={vi.fn()}
        snapshot={snapshot}
        deadlineMs={3000}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(document.querySelector('.wm-modal-content')).toBeNull();
  });
});

describe('SplashWatchdog — breadcrumb', () => {
  it('Modal 渲染时写 splash_timeout breadcrumb 一次', () => {
    render(
      <SplashWatchdog
        layoutReady={false}
        forceEnter={vi.fn()}
        snapshot={snapshot}
        deadlineMs={3000}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(breadcrumb).toHaveBeenCalledTimes(1);
    const arg = breadcrumb.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg).toMatchObject({ event: 'splash_timeout', layoutReady: false });
  });
});

describe('SplashWatchdog — 按钮行为', () => {
  function openModal(forceEnter = vi.fn()) {
    render(
      <SplashWatchdog
        layoutReady={false}
        forceEnter={forceEnter}
        snapshot={snapshot}
        deadlineMs={3000}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    return { forceEnter };
  }

  function findButton(label: string): HTMLButtonElement | null {
    for (const b of document.querySelectorAll<HTMLButtonElement>(
      '.wm-modal-content button',
    )) {
      if ((b.textContent ?? '').includes(label)) return b;
    }
    return null;
  }

  it('点"强制进入"调 forceEnter 回调', () => {
    const { forceEnter } = openModal();
    const btn = findButton('强制进入');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(forceEnter).toHaveBeenCalledTimes(1);
  });

  it('点"打开日志目录"调 coApi.shell.openLogsDir', () => {
    openModal();
    const btn = findButton('日志');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(openLogsDir).toHaveBeenCalledTimes(1);
  });

  it('点"重新启动"调 coApi.app.relaunch', () => {
    openModal();
    const btn = findButton('重新启动');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
