// @vitest-environment jsdom
// BDD:色觉 / 强制颜色下的非颜色线索 —— toast 等级图标按形状区分(契约 3)。见同目录 README。
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Toast } from '../../notifications/Toast';
import type { NotificationLevel } from '../../notifications/types';

afterEach(() => cleanup());

const LEVELS: readonly NotificationLevel[] = ['error', 'warning', 'info', 'success'];

function iconOf(level: NotificationLevel): HTMLElement {
  const { container } = render(
    <Toast
      notification={{ id: level, level, message: `m-${level}`, createdAt: 0 }}
      onDismiss={vi.fn()}
      dismissLabel="Dismiss"
      onPause={vi.fn()}
      onResume={vi.fn()}
    />,
  );
  return container.querySelector<HTMLElement>('.toast__icon')!;
}

describe('toast 等级图标', () => {
  it('每个等级一个 SVG(aria-hidden,描边 currentColor = 等级色),形状两两不同', () => {
    const shapes = LEVELS.map((level) => {
      const icon = iconOf(level);
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.getAttribute('data-icon')).toBe(level);
      const svg = icon.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('stroke')).toBe('currentColor');
      return svg!.innerHTML;
    });
    expect(new Set(shapes).size).toBe(LEVELS.length);
  });

  it('不再是只靠颜色区分的实心圆点(.toast__icon 不画背景)', () => {
    const css = readFileSync('src/notifications/Toast.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.toast__icon\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).not.toBe('');
    expect(rule).not.toMatch(/background/);
    expect(rule).not.toMatch(/border-radius:\s*50%/);
  });
});
