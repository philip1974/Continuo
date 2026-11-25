// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { EmptyState } from '../../shell/dock/EmptyState';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
}

describe('EmptyState', () => {
  it('装饰 empty icon 预创建,不随 render 重建 svg element', () => {
    const src = readFileSync(join(process.cwd(), 'src/shell/dock/EmptyState.tsx'), 'utf8');

    expect(src).toContain('const EMPTY_DOCK_ICON = (');
    expect(src).toContain('{EMPTY_DOCK_ICON}');
  });

  it('渲染 data-testid + 文案 + 按钮', () => {
    const { container } = render(<EmptyState onRestore={vi.fn()} />);
    expect(container.querySelector('[data-testid=empty-state]')).not.toBeNull();
    expect(container.textContent).toContain('所有面板都关掉了');
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (b) => b.textContent === '恢复默认布局',
      ),
    ).toBe(true);
  });

  it('容器是 F6 的空 dock 落点:data-dock-empty + tabIndex=-1(只经脚本聚焦,不进 Tab 顺序)', () => {
    const { container } = render(<EmptyState onRestore={vi.fn()} />);
    const root = container.querySelector<HTMLElement>('[data-testid=empty-state]')!;
    expect(root.hasAttribute('data-dock-empty')).toBe(true);
    expect(root.tabIndex).toBe(-1);
  });

  it('点「恢复默认布局」 → onRestore', () => {
    const onRestore = vi.fn();
    const { container } = render(<EmptyState onRestore={onRestore} />);
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '恢复默认布局',
    )!;
    fireEvent.click(btn);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('document.visibilityState !== "hidden" 且窗口有焦点 → 渲染 BackgroundBeams svg', () => {
    setVisibility('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { container } = render(<EmptyState onRestore={vi.fn()} />);
    // BackgroundBeams 渲染 svg 元素;EmptyState 的内置 icon 也是 svg。
    // 总 svg 数 ≥ 2 时认为 BackgroundBeams 在场
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(2);
  });

  it('visibilitychange → hidden 时移除 BackgroundBeams', () => {
    setVisibility('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { container } = render(<EmptyState onRestore={vi.fn()} />);
    const initialSvgs = container.querySelectorAll('svg').length;

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const after = container.querySelectorAll('svg').length;
    expect(after).toBeLessThan(initialSvgs);
  });

  // 主进程 backgroundThrottling:false(issue #34)下,Electron 文档明确:最小化 / 遮挡 /
  // 隐藏窗口时 visibilityState 仍为 'visible',只靠它挡不住后台 60fps 补间。
  // 窗口失焦覆盖最小化 / Cmd+H / 被其它窗口遮挡;误判(并排可见但失焦)只是装饰暂停,无害。
  it('窗口 blur 时移除 BackgroundBeams,focus 后恢复(visibilityState 始终 visible)', () => {
    setVisibility('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { container } = render(<EmptyState onRestore={vi.fn()} />);
    const initialSvgs = container.querySelectorAll('svg').length;
    expect(initialSvgs).toBeGreaterThanOrEqual(2);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(container.querySelectorAll('svg').length).toBeLessThan(initialSvgs);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(container.querySelectorAll('svg').length).toBe(initialSvgs);
  });

  it('挂载时窗口无焦点 → 不渲染 BackgroundBeams', () => {
    setVisibility('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { container } = render(<EmptyState onRestore={vi.fn()} />);
    expect(container.querySelectorAll('svg').length).toBe(1);
  });
  // 初值在渲染时读,监听在 passive effect(绘制后)才挂:其间焦点变化(如启动恢复多窗口,后建窗口抢焦点)
  // 漏掉 → 后台窗口持续补间。effect 挂监听后须立即重新同步一次。
  it('渲染时有焦点、监听挂上前已失焦 → effect 同步后不渲染 BackgroundBeams', () => {
    setVisibility('visible');
    let first = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => {
      if (first) {
        first = false;
        return true;
      }
      return false;
    });
    const { container } = render(<EmptyState onRestore={vi.fn()} />);
    expect(container.querySelectorAll('svg').length).toBe(1);
  });
});
