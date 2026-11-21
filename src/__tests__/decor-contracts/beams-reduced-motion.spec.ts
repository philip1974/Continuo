// BackgroundBeams 在 reduced-motion 下必须是静态渐变。
// motion 的 MotionConfig reducedMotion="user" 只关闭 transform / 布局类属性的动画,
// linearGradient 的 x1/x2/y1/y2 不在其内,所以组件要自己按 reduced-motion 去掉 animate。
import { describe, expect, it } from 'vitest';
import { beamGradientMotion } from '@/shell/decor/BackgroundBeams';

const transition = { duration: 10, delay: 2, y2End: '93%' };

describe('BackgroundBeams · reduced-motion', () => {
  it('正常模式:渐变循环动画', () => {
    const props = beamGradientMotion(false, transition);
    expect(props.animate).toBeDefined();
    expect(props.transition).toMatchObject({ duration: 10, delay: 2, repeat: Infinity });
  });

  it('reduced-motion:不带 animate / transition,停在初始静态渐变', () => {
    const props = beamGradientMotion(true, transition);
    expect(props.initial).toEqual({ x1: '0%', x2: '0%', y1: '0%', y2: '0%' });
    expect(props).not.toHaveProperty('animate');
    expect(props).not.toHaveProperty('transition');
  });
});
