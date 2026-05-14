// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { render, screen } from '@testing-library/react';
import { DockShell } from '@/shell/dock/DockShell';
import { reconcileTerminalPanels } from '@/shell/dock/DockReconciler';

vi.mock('dockview-react', () => ({
  DockviewReact: ({ onReady }: { onReady: (event: { api: unknown }) => void }) => {
    const api = {
      totalPanels: 0,
      fromJSON: vi.fn(),
      toJSON: vi.fn(() => ({ panels: {} })),
      getPanel: vi.fn(() => null),
      addPanel: vi.fn(),
      onDidLayoutChange: vi.fn(),
      onDidRemovePanel: vi.fn(),
      onDidAddPanel: vi.fn(),
      panels: [],
    };
    React.useEffect(() => {
      onReady({ api });
    }, []);
    return React.createElement('div', { 'data-testid': 'dockview' });
  },
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    layout: {
      read: vi.fn().mockResolvedValue({ ok: true, data: { panels: {} } }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    terminal: {
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
    system: { windowId: 1 },
  },
}));

describe('terminal panel empty dock', () => {
  it('DockShell 状态 totalPanels=0 → 渲染 EmptyState', async () => {
    render(React.createElement(DockShell));

    expect(
      (await screen.findAllByText(/所有面板都关掉了|恢复默认布局/)).length,
    ).toBeGreaterThan(0);
  });

  it('关闭最后一个 terminal panel 不触发 reconciler add 新 panel', () => {
    const api = {
      addPanel: vi.fn(),
      getPanel: vi.fn(() => null),
      panels: [],
      totalPanels: 0,
    };

    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [],
      nextSessions: [],
    });

    expect(api.addPanel).not.toHaveBeenCalled();
  });
});
