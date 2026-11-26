// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { cleanup, render, screen } from '@testing-library/react';
import { DockShell } from '@/shell/dock/DockShell';
import { reconcileTerminalPanels } from '@/shell/dock/DockReconciler';

// 主窗面板(popout 子窗里的面板不算主窗;用例按需改)。
const h = vi.hoisted(() => ({ panels: [] as unknown[] }));

vi.mock('dockview-react', () => ({
  DockviewReact: ({ onReady }: { onReady: (event: { api: unknown }) => void }) => {
    const api = React.useMemo(
      () => ({
        get totalPanels() {
          return h.panels.length;
        },
        fromJSON: vi.fn(),
        toJSON: vi.fn(() => ({ panels: {} })),
        getPanel: vi.fn(() => null),
        addPanel: vi.fn(),
        // dockview 事件订阅返回 disposable(卸载时 dispose)。
        onDidLayoutChange: vi.fn(() => ({ dispose: vi.fn() })),
        onDidRemovePanel: vi.fn(() => ({ dispose: vi.fn() })),
        onDidAddPanel: vi.fn(() => ({ dispose: vi.fn() })),
        onDidMaximizedGroupChange: vi.fn(() => ({ dispose: vi.fn() })), // topic-22
        onDidActiveGroupChange: vi.fn(() => ({ dispose: vi.fn() })),
        onDidActivePanelChange: vi.fn(() => ({ dispose: vi.fn() })),
        // popout 文档跟踪(trackPopoutDocuments)。
        onDidAddGroup: vi.fn(() => ({ dispose: vi.fn() })),
        onDidRemoveGroup: vi.fn(() => ({ dispose: vi.fn() })),
        groups: [],
        get panels() {
          return h.panels;
        },
      }),
      [],
    );
    React.useEffect(() => {
      onReady({ api });
    }, [api, onReady]);
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

afterEach(() => {
  cleanup();
  h.panels = [];
});

describe('terminal panel empty dock', () => {
  it('DockShell 状态 totalPanels=0 → 渲染 EmptyState', async () => {
    render(React.createElement(DockShell));

    expect(
      (await screen.findAllByText(/所有面板都关掉了|恢复默认布局/)).length,
    ).toBeGreaterThan(0);
  });

  it('面板全在 popout 子窗(totalPanels>0 但主窗无面板)→ 主窗同样渲染 EmptyState(VSCode:主窗保留空编辑器组)', async () => {
    h.panels = [
      {
        id: 'editor',
        api: {
          id: 'editor',
          location: { type: 'popout' },
          group: { id: 'pg', panels: [] },
          close: vi.fn(),
          onDidLocationChange: vi.fn(() => ({ dispose: vi.fn() })),
        },
      },
    ];
    render(React.createElement(DockShell));

    expect(await screen.findByTestId('empty-state')).toBeTruthy();
    // 面板未关,只是在子窗:文案如实,不提供「恢复默认布局」
    expect(screen.getByText('所有面板都在其他窗口中。')).toBeTruthy();
    expect(screen.queryByText('恢复默认布局')).toBeNull();
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
