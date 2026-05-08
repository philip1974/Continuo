// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { EmptyState } from '../../shell/dock/EmptyState';

afterEach(() => cleanup());

describe('EmptyState', () => {
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

  it('点「恢复默认布局」 → onRestore', () => {
    const onRestore = vi.fn();
    const { container } = render(<EmptyState onRestore={onRestore} />);
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '恢复默认布局',
    )!;
    fireEvent.click(btn);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('document.visibilityState !== "hidden" → 渲染 BackgroundBeams svg', () => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    const { container } = render(<EmptyState onRestore={vi.fn()} />);
    // BackgroundBeams 渲染 svg 元素;EmptyState 的内置 icon 也是 svg。
    // 总 svg 数 ≥ 2 时认为 BackgroundBeams 在场
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(2);
  });

  it('visibilitychange → hidden 时移除 BackgroundBeams', () => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
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
});
