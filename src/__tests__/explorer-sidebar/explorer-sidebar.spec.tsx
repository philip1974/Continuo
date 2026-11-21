// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { ExplorerSidebar } from '../../shell/ExplorerSidebar';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

beforeEach(() => {
  _resetLmApiForTest();
  // 没 workspace → Explorer 渲染 EmptyWorkspace,避开 FolderTree 重依赖
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
  Object.defineProperty(window, 'api', {
    value: { fs: { selectDirectory: vi.fn() } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('ExplorerSidebar', () => {
  it('拖拽条 label 在 render 内复用,不为 aria/title 重复翻译', () => {
    const src = readFileSync(join(process.cwd(), 'src/shell/ExplorerSidebar.tsx'), 'utf8');

    expect(src).toContain("const resizeLabel = t('shell.aria.drag_resize');");
    expect(src).toContain('aria-label={resizeLabel}');
    expect(src).toContain('title={resizeLabel}');
    expect(src).not.toContain("aria-label={t('shell.aria.drag_resize')}");
    expect(src).not.toContain("title={t('shell.aria.drag_resize')}");
  });

  it('sidebarOpen=false → 不渲染', () => {
    useLayoutUiStore.setState({ sidebarOpen: false });
    const { container } = render(<ExplorerSidebar />);
    expect(container.querySelector('aside')).toBeNull();
  });

  it('sidebarOpen=true → 渲染 aside,内含拖拽条', () => {
    const { container } = render(<ExplorerSidebar />);
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(aside!.style.width).toBe('280px');
    const handle = container.querySelector('.cursor-col-resize');
    expect(handle).not.toBeNull();
  });

  // a11y(A14):resize separator 须键盘可达(tabIndex + window-splitter aria-value*),
  // 且 Arrow/Home/End 调宽。
  it('a11y · separator 可聚焦 + aria-value* + 键盘调宽', () => {
    const { container } = render(<ExplorerSidebar />);
    const sep = container.querySelector(
      '[role=separator]',
    ) as HTMLDivElement;
    expect(sep).not.toBeNull();
    expect(sep.getAttribute('tabindex')).toBe('0');
    expect(sep.getAttribute('aria-valuemin')).toBe('200');
    expect(sep.getAttribute('aria-valuemax')).toBe('500');
    expect(sep.getAttribute('aria-valuenow')).toBe('280');
    // ArrowRight → +16
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(useLayoutUiStore.getState().sidebarWidth).toBe(296);
    // ArrowLeft → -16
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(useLayoutUiStore.getState().sidebarWidth).toBe(280);
    // Home → min(clamp),End → max
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(useLayoutUiStore.getState().sidebarWidth).toBe(200);
    fireEvent.keyDown(sep, { key: 'End' });
    expect(useLayoutUiStore.getState().sidebarWidth).toBe(500);
  });

  it('store sidebarWidth 变化 → aside style.width 更新', () => {
    const { container, rerender } = render(<ExplorerSidebar />);
    expect(container.querySelector('aside')!.style.width).toBe('280px');

    useLayoutUiStore.setState({ sidebarWidth: 360 });
    rerender(<ExplorerSidebar />);
    expect(container.querySelector('aside')!.style.width).toBe('360px');
  });
});
