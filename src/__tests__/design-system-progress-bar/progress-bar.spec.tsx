// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { ProgressBar } from '@/design';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const bar = () => document.querySelector('[role="progressbar"]');

describe('ProgressBar — 延迟出现的不确定进度细条', () => {
  it('delayMs 缺省 0:active 即渲染 role=progressbar(无 aria-valuenow),className 合并、属性透传', () => {
    render(<ProgressBar active aria-label="正在搜索" className="absolute top-0" />);
    const el = bar()!;
    expect(el).not.toBeNull();
    expect(el.getAttribute('aria-label')).toBe('正在搜索');
    expect(el.hasAttribute('aria-valuenow')).toBe(false);
    expect(el.className).toBe('wm-progress absolute top-0');
    expect(el.querySelector('.wm-progress-bit')).not.toBeNull();
  });

  it('active 满 delayMs 才出现;变 false 立即消失;延迟内结束则始终不出现', () => {
    vi.useFakeTimers();
    const { rerender } = render(<ProgressBar active delayMs={300} aria-label="x" />);
    act(() => vi.advanceTimersByTime(299));
    expect(bar()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(bar()).not.toBeNull();
    rerender(<ProgressBar active={false} delayMs={300} aria-label="x" />);
    expect(bar()).toBeNull();

    // 再次开始:重新计时;延迟内结束 → 不闪
    rerender(<ProgressBar active delayMs={300} aria-label="x" />);
    act(() => vi.advanceTimersByTime(200));
    rerender(<ProgressBar active={false} delayMs={300} aria-label="x" />);
    act(() => vi.advanceTimersByTime(500));
    expect(bar()).toBeNull();
    rerender(<ProgressBar active delayMs={300} aria-label="x" />);
    act(() => vi.advanceTimersByTime(299));
    expect(bar()).toBeNull();
  });

  it('样式:2px 高、--md-primary 细条、token 时长扫动;减弱动效时静止整条;无字面色值', () => {
    const css = readFileSync(join(process.cwd(), 'src/design/ProgressBar.css'), 'utf8');
    expect(css).toMatch(/\.wm-progress\s*\{[^}]*height:\s*2px/);
    expect(css).toMatch(/\.wm-progress-bit\s*\{[^}]*background-color:\s*var\(--md-primary\)/);
    expect(css).toMatch(/animation:\s*wm-progress-slide var\(--wm-duration-progress\)/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(readFileSync(join(process.cwd(), 'src/styles/theme.css'), 'utf8')).toMatch(/--wm-duration-progress:/);
  });
});
