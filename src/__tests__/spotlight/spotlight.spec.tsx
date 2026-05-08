// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Spotlight } from '../../shell/decor/Spotlight';

afterEach(() => cleanup());

describe('Spotlight', () => {
  it('渲染 svg + 标准属性 + 滤镜', () => {
    const { container } = render(<Spotlight />);
    const svg = container.querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('viewBox')).toBe('0 0 3787 2842');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(
      container.querySelector('filter#lm-spotlight-filter'),
    ).not.toBeNull();
  });

  it('fill 缺 → 椭圆 fill="white"', () => {
    const { container } = render(<Spotlight />);
    const ellipse = container.querySelector('ellipse')!;
    expect(ellipse.getAttribute('fill')).toBe('white');
  });

  it('fill 提供 → 椭圆透传', () => {
    const { container } = render(<Spotlight fill="#ff0000" />);
    expect(container.querySelector('ellipse')!.getAttribute('fill')).toBe(
      '#ff0000',
    );
  });

  it('className 与默认类合并', () => {
    const { container } = render(<Spotlight className="custom-x" />);
    const cls = container.querySelector('svg')!.getAttribute('class')!;
    expect(cls).toContain('custom-x');
    expect(cls).toContain('animate-spotlight');
  });
});
