// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  layoutChange: null as null | (() => void),
  api: {
    totalPanels: 3,
    fromJSON: vi.fn(),
    toJSON: vi.fn(() => ({ panels: {} })),
    getPanel: vi.fn(() => null),
    panels: [],
    onDidLayoutChange: vi.fn((cb: () => void) => {
      mocks.layoutChange = cb;
      return { dispose: vi.fn() };
    }),
    onDidRemovePanel: vi.fn(),
    onDidAddPanel: vi.fn(),
  },
}));

vi.mock('dockview-react', () => ({
  DockviewReact: ({ onReady }: { onReady: (event: { api: typeof mocks.api }) => void }) => {
    React.useEffect(() => {
      void onReady({ api: mocks.api });
    }, [onReady]);
    return React.createElement('div', { 'data-testid': 'dockview' });
  },
}));
vi.mock('../../plugins/co-app', () => ({ coApp: { panels: { getAll: () => [], subscribe: () => vi.fn() } } }));
vi.mock('../../shell/motion/PanelMount', () => ({ PanelMount: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../shell/dock/layout.default', () => ({ applyDefaultLayout: vi.fn() }));
vi.mock('../../shell/dock/HeaderActions', () => ({ HeaderActions: () => null }));
vi.mock('../../shell/dock/EmptyState', () => ({ EmptyState: () => React.createElement('div', null, 'empty-layout') }));
vi.mock('../../shell/dock/dock-api-ref', () => ({ setDockApi: vi.fn() }));
vi.mock('../../shell/dock/wrap-panel-close', () => ({ wrapPanelClose: vi.fn() }));
vi.mock('../../shell/motion/SharedTab', () => ({ SharedTab: () => null }));
vi.mock('../../stores/editor.store', () => ({ useEditorStore: () => null }));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    layout: {
      read: vi.fn().mockResolvedValue({ ok: true, data: null }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
  },
}));

import { DockShell } from '../../shell/dock/DockShell';

describe('tab split panes - close all panels empty', () => {
  it('keeps DockShell mounted and shows empty state when all panels are closed', async () => {
    render(React.createElement(DockShell));
    await waitFor(() => expect(mocks.layoutChange).toEqual(expect.any(Function)));

    mocks.api.totalPanels = 0;
    mocks.layoutChange?.();

    expect(screen.getByTestId('dockview')).not.toBeNull();
    expect(await screen.findByText('empty-layout')).not.toBeNull();
  });
});
