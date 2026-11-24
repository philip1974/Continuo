// @vitest-environment jsdom
// BDD:dock 图层收进自身层叠上下文,不压过 toast / 模态 / 菜单。见同目录 README。
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// 只验根容器结构:dockview 本体换成占位,onReady 不触发(布局 / 终端逻辑与本主题无关)。
vi.mock('dockview-react', () => ({
  DockviewReact: () => React.createElement('div', { 'data-testid': 'dockview' }),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    layout: { read: () => new Promise(() => {}), write: vi.fn() },
    system: { windowId: 1 },
  },
}));

import { DockShell } from '@/shell/dock/DockShell';

afterEach(cleanup);

describe('dock 层叠上下文', () => {
  it('主窗:DockShell 根容器 isolation: isolate,dockview 的 z-index 不与全局浮层同层比较', () => {
    render(React.createElement(DockShell));
    const root = screen.getByTestId('dockview').parentElement!;
    expect(root.classList).toContain('isolate');
  });

  it('popout 子窗:.dv-popout-window 容器 isolation: isolate(dockview.css)', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/dockview.css'), 'utf8');
    const rule = /\.dv-popout-window\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/isolation:\s*isolate/);
  });
});
