// @vitest-environment jsdom
// BDD: terminal-vscode-parity / 6-8 dock tab 关闭按钮、拖拽落点高亮与溢出按钮
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SharedTab } from '../../shell/motion/SharedTab';

function renderTab(isActive: boolean) {
  const api = {
    id: 'p1',
    title: 'Terminal 1',
    isActive,
    group: { id: 'g1', api: { isMaximized: () => false }, panels: [] },
    close: vi.fn(),
    setActive: vi.fn(),
    onDidActiveChange: () => ({ dispose: vi.fn() }),
    onDidTitleChange: () => ({ dispose: vi.fn() }),
    onDidGroupChange: () => ({ dispose: vi.fn() }),
  };
  const props = {
    api,
    containerApi: { onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }), exitMaximizedGroup: vi.fn() },
    params: {},
  } as unknown as Parameters<typeof SharedTab>[0];
  return render(<SharedTab {...props} />);
}

afterEach(() => cleanup());

describe('6 · 激活 tab 的关闭按钮常显', () => {
  const closeButton = (c: HTMLElement) => c.querySelector<HTMLElement>('button[aria-label*="Terminal 1"]')!;
  it('激活 tab:不靠悬停,常显', () => {
    const { container } = renderTab(true);
    expect(closeButton(container).className).not.toContain('opacity-0');
  });
  it('非激活 tab:仍只在悬停 / 键盘聚焦时显示', () => {
    const { container } = renderTab(false);
    expect(closeButton(container).className).toContain('opacity-0');
    expect(closeButton(container).className).toContain('group-hover/tab:opacity-100');
  });
});

describe('7-8 · dockview 主题桥接', () => {
  const css = readFileSync('src/styles/dockview.css', 'utf-8');
  const abyss = css.slice(css.indexOf('.dockview-theme-abyss {'), css.indexOf('}', css.indexOf('.dockview-theme-abyss {')));
  it('拖拽落点高亮等 abyss 字面色变量都改接 --md-* token', () => {
    expect(abyss).toMatch(/--dv-drag-over-background-color:\s*color-mix\(in srgb, var\(--md-primary\)/);
    for (const v of ['--dv-icon-hover-background-color', '--dv-tabs-container-scrollbar-color', '--dv-floating-box-shadow', '--dv-floating-border']) {
      expect(abyss).toMatch(new RegExp(`${v}:[^;]*var\\(--(md|wm)-`));
    }
    // 桥接块里不出现字面色
    expect(abyss).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
  it('溢出下拉按钮有不透明底与分隔线(不与被截断的 tab 文字粘连)', () => {
    const rule = css.slice(css.indexOf('.dv-tabs-overflow-dropdown-root {'));
    expect(rule).toMatch(/background-color:\s*var\(--dv-tabs-and-actions-container-background-color\)/);
    expect(rule).toMatch(/border-left:\s*1px solid var\(--dv-tab-divider-color\)/);
  });
});
