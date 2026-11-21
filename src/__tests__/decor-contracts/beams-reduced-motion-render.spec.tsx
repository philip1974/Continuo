// @vitest-environment jsdom
// 组件接线:BackgroundBeams 必须读 MotionConfig 的 reduced-motion 设置并据此静止渐变。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MotionConfig } from 'motion/react';
import { BackgroundBeams } from '@/shell/decor/BackgroundBeams';

afterEach(cleanup);

function renderBeams(reducedMotion: 'always' | 'never') {
  const { container } = render(
    <MotionConfig reducedMotion={reducedMotion}>
      <BackgroundBeams />
    </MotionConfig>,
  );
  return [...container.querySelectorAll('linearGradient')].map((g) => g.getAttribute('data-animated'));
}

describe('BackgroundBeams · reduced-motion 接线', () => {
  it('reducedMotion="always" → 静态渐变', () => {
    const flags = renderBeams('always');
    expect(flags.length).toBeGreaterThan(0);
    expect(new Set(flags)).toEqual(new Set(['false']));
  });

  it('reducedMotion="never" → 动画渐变', () => {
    const flags = renderBeams('never');
    expect(flags.length).toBeGreaterThan(0);
    expect(new Set(flags)).toEqual(new Set(['true']));
  });
});
