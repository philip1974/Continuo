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
  sidebarMaxWidthFor,
  useLayoutUiStore,
} from '../../stores/layout-ui.store';
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
