// @vitest-environment jsdom
// 窄窗口侧栏让位(对齐 VSCode:窗口变窄时侧栏先缩,编辑区保最小宽度 220px —— VSCode
// DEFAULT_EDITOR_MIN_DIMENSIONS.width):
// 显示宽度 = clamp(SIDEBAR_MIN_WIDTH, sidebarWidth, 可用宽 − EDITOR_MIN_WIDTH);保存的 sidebarWidth 不变,
// 窗口放大后恢复;键盘 / 拖拽的上限同样受窗口宽约束。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { ExplorerSidebar } from '../../shell/ExplorerSidebar';
import {
  EDITOR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarFitsBesideDock,
  sidebarMaxWidthFor,
  useLayoutUiStore,
} from '../../stores/layout-ui.store';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import type { DockviewApi } from 'dockview-react';
import { useWorkspaceStore } from '../../stores/workspace.store';

const originalWidth = window.innerWidth;

function setWindowWidth(w: number) {
  act(() => {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  _resetLmApiForTest();
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
  Object.defineProperty(window, 'api', {
    value: { fs: { selectDirectory: vi.fn() } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true });
});

afterEach(() => {
  act(() => setDockApi(null));
  delete (window as { api?: unknown }).api;
  cleanup();
  Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true, writable: true });
  vi.restoreAllMocks();
});

describe('侧栏宽度受窗口宽约束', () => {
  it('sidebarMaxWidthFor:可用宽扣掉编辑区最小宽度,夹在 [MIN, MAX]', () => {
    expect(EDITOR_MIN_WIDTH).toBe(220);
    expect(sidebarMaxWidthFor(1400)).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarMaxWidthFor(640)).toBe(640 - EDITOR_MIN_WIDTH);
    expect(sidebarMaxWidthFor(352)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('窗口变窄 → 显示宽度让位,保存值不变;放大后恢复', () => {
    useLayoutUiStore.setState({ sidebarWidth: 480 });
    const { container } = render(<ExplorerSidebar />);
    const aside = container.querySelector('aside')!;
    expect(aside.style.width).toBe('480px');

    setWindowWidth(640);
    expect(aside.style.width).toBe(`${640 - EDITOR_MIN_WIDTH}px`);
    setWindowWidth(400);
    expect(aside.style.width).toBe(`${SIDEBAR_MIN_WIDTH}px`);
    expect(useLayoutUiStore.getState().sidebarWidth).toBe(480);

    setWindowWidth(1400);
    expect(aside.style.width).toBe('480px');
  });

  it('窄窗口下 separator 的 aria-valuemax / valuenow 反映有效上限,End 只到有效上限', () => {
    useLayoutUiStore.setState({ sidebarWidth: 480 });
    const { container } = render(<ExplorerSidebar />);
    setWindowWidth(640);
    const sep = container.querySelector('[role=separator]') as HTMLDivElement;
    expect(sep.getAttribute('aria-valuemax')).toBe(String(640 - EDITOR_MIN_WIDTH));
    expect(sep.getAttribute('aria-valuenow')).toBe(String(640 - EDITOR_MIN_WIDTH));
    // 从显示宽度起调:ArrowLeft 立即可见地变窄
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(useLayoutUiStore.getState().sidebarWidth).toBe(640 - EDITOR_MIN_WIDTH - 16);
    fireEvent.keyDown(sep, { key: 'End' });
    expect(useLayoutUiStore.getState().sidebarWidth).toBe(640 - EDITOR_MIN_WIDTH);
  });

  it('拖拽上限同样受窗口宽约束,且从显示宽度起拖', () => {
    useLayoutUiStore.setState({ sidebarWidth: 480 });
    const { container } = render(<ExplorerSidebar />);
    setWindowWidth(640);
    const sep = container.querySelector('[role=separator]') as HTMLDivElement;
    fireEvent.mouseDown(sep, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 300 });
    expect(useLayoutUiStore.getState().sidebarWidth).toBe(640 - EDITOR_MIN_WIDTH);
    fireEvent.mouseMove(document, { clientX: 90 });
    expect(useLayoutUiStore.getState().sidebarWidth).toBe(640 - EDITOR_MIN_WIDTH - 10);
    fireEvent.mouseUp(document);
  });
});

/** 假 dock api:只有 minimumWidth 与布局事件(网格最小宽 = 各组最小宽之和,由测试设定)。 */
function fakeDock(minimumWidth: number) {
  const listeners = new Set<() => void>();
  const on = (cb: () => void) => {
    listeners.add(cb);
    return { dispose: () => listeners.delete(cb) };
  };
  const dock = {
    minimumWidth,
    onDidLayoutChange: on,
    onDidAddGroup: on,
    onDidRemoveGroup: on,
  };
  return {
    api: dock as unknown as DockviewApi,
    setMin(w: number) {
      act(() => {
        dock.minimumWidth = w;
        for (const l of [...listeners]) l();
      });
    },
  };
}

describe('侧栏让位按 dock 网格实际最小宽度(多组并排)', () => {
  it('sidebarMaxWidthFor:扣掉 max(EDITOR_MIN_WIDTH, dock 最小宽);sidebarFitsBesideDock 只看 dock 实际最小宽', () => {
    expect(sidebarMaxWidthFor(600, 100)).toBe(600 - EDITOR_MIN_WIDTH);
    expect(sidebarMaxWidthFor(900, 470)).toBe(900 - 470);
    expect(sidebarMaxWidthFor(600, 470)).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarFitsBesideDock(352, 100)).toBe(true);
    expect(sidebarFitsBesideDock(352, 152)).toBe(true);
    expect(sidebarFitsBesideDock(352, 200)).toBe(false);
  });

  it('三组并排(最小宽 300)+ 窗口 700:侧栏显示宽 = 可用宽 − 300,保存值不变', () => {
    const dock = fakeDock(300);
    act(() => setDockApi(dock.api));
    useLayoutUiStore.setState({ sidebarWidth: 480 });
    const { container } = render(<ExplorerSidebar />);
    setWindowWidth(700);
    const aside = container.querySelector('aside')!;
    expect(aside.style.width).toBe(`${700 - 300}px`);
    // 再加一组(最小宽 450)→ 侧栏随之让位
    dock.setMin(450);
    expect(aside.style.width).toBe(`${700 - 450}px`);
    expect(container.querySelector('[role=separator]')!.getAttribute('aria-valuemax')).toBe(String(700 - 450));
    expect(useLayoutUiStore.getState().sidebarWidth).toBe(480);
  });

  it('窗口变窄到侧栏缩到最小宽 dock 仍放不下 → 侧栏收起(sidebarOpen=false,同 VSCode snap);单组时不收起', () => {
    const dock = fakeDock(100);
    act(() => setDockApi(dock.api));
    render(<ExplorerSidebar />);
    setWindowWidth(352); // 单组:352 − 200 ≥ 100,保留最小宽侧栏(jsdom 里侧栏左边缘 0,可用宽 = 窗口宽)
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
    dock.setMin(200); // 两组并排:352 − 200 < 200 放不下 → 收起
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
  });

  it('窗口缩窄触发收起;用户在窄窗口里再打开侧栏 → 不会被立刻收回(只在「放得下 → 放不下」时收起)', () => {
    const dock = fakeDock(200);
    act(() => setDockApi(dock.api));
    render(<ExplorerSidebar />);
    setWindowWidth(800);
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
    setWindowWidth(352);
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
    act(() => useLayoutUiStore.getState().setSidebarOpen(true));
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
    setWindowWidth(340);
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
  });
});
