// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup } from '@testing-library/react';
import { BackgroundBeams } from '../../shell/decor/BackgroundBeams';
import { Splash } from '../../shell/decor/Splash';
import { PopoutHost } from '../../shell/PopoutHost';

afterEach(() => cleanup());

describe('BackgroundBeams', () => {
  it('静态 path 元数据预计算,render 不重复拼接 stroke/id/key', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/shell/decor/BackgroundBeams.tsx'),
      'utf8',
    );

    expect(src).toContain('const BEAM_PATHS: readonly BeamPath[] = PATHS.map');
    expect(src).toContain('BEAM_PATHS.map(({ key, d, stroke })');
    expect(src).toContain('BEAM_PATHS.map((beam, index)');
    expect(src).not.toContain('stroke={`url(#lm-beam-${index})`}');
    expect(src).not.toContain('id={`lm-beam-${index}`}');
    expect(src).not.toContain('key={`path-${index}`}');
  });

  it('渲染 svg viewBox + aria-hidden + 50 path / 50 gradient', () => {
    const { container } = render(<BackgroundBeams />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('0 0 696 316');
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('path').length).toBe(50);
    expect(container.querySelectorAll('linearGradient').length).toBe(50);
  });

  it('className prop 与默认类合并', () => {
    const { container } = render(<BackgroundBeams className="custom-bb" />);
    const wrap = container.querySelector('div');
    expect(wrap!.className).toContain('custom-bb');
    expect(wrap!.className).toContain('pointer-events-none');
  });
});

describe('Splash', () => {
  it('data-testid + 渲染标题 Continuo + Spotlight svg', () => {
    const { container } = render(<Splash />);
    const root = container.querySelector('[data-testid=splash]');
    expect(root).not.toBeNull();
    expect(root!.textContent).toContain('Continuo');
    // Spotlight 自身是 svg
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('PopoutHost', () => {
  it('data-testid="popout-host" + 单 div', () => {
    const { container } = render(<PopoutHost />);
    expect(container.querySelector('[data-testid=popout-host]')).not.toBeNull();
  });
});
