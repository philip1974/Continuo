// @vitest-environment jsdom
// Splash 就绪屏障:DockShell 的 onLayoutReady(App 据此移除 Splash)须等「布局恢复 + 终端 sessions
// 首个权威快照 + Reconciler 首轮 reconcile」都完成,而非仅布局恢复;快照久不到达有安全上限,不永久
// 遮挡。另:首个快照晚于 Reconciler 挂载到达时,其中的存量 session 仍按 hydrate 处理,不 setActive
// 抢走 fromJSON 恢复的活动面板。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useTerminalStore } from '@/stores/terminal.store';
import { __resetReconcilerForTest } from '@/shell/dock/DockReconciler';
import { useEditorStore } from '@/stores/editor.store';
import { makeSession } from '../dock-reconciler-windowid-filter/fixtures';

interface FakePanel {
  id: string;
  params: unknown;
  api: {
    id: string;
    title: string;
    setActive: () => void;
    close: () => void;
    setTitle: (t: string) => void;
  };
}

const h = vi.hoisted(() => ({
  read: vi.fn(),
  onFlushRequest: vi.fn(() => () => {}),
  api: null as null | { panels: FakePanel[]; activePanel: FakePanel | undefined },
}));

const noopDisposable = () => ({ dispose: () => {} });

vi.mock('dockview-react', () => ({
  DockviewReact: ({ onReady }: { onReady: (event: { api: unknown }) => void }) => {
    const api = React.useMemo(() => {
      const panels: FakePanel[] = [];
      const self = {
        panels,
        get totalPanels() {
          return panels.length;
        },
        activePanel: undefined as FakePanel | undefined,
        fromJSON: vi.fn((json: { panels?: Record<string, unknown> }) => {
          panels.length = 0;
          for (const id of Object.keys(json.panels ?? {})) {
            self.addPanel({ id, params: {} });
          }
        }),
        toJSON: vi.fn(() => ({ panels: {} })),
        getPanel: vi.fn((id: string) => panels.find((p) => p.id === id)),
        addPanel: vi.fn((opts: { id: string; params?: unknown; title?: string }) => {
          const p: FakePanel = {
            id: opts.id,
            params: opts.params,
            api: {
              id: opts.id,
              title: opts.title ?? opts.id,
              setActive: () => {
                self.activePanel = p;
              },
              close: () => {
                const i = panels.indexOf(p);
                if (i >= 0) panels.splice(i, 1);
              },
              setTitle: () => {},
            },
          };
          panels.push(p);
          self.activePanel = p;
          return p;
        }),
        onDidLayoutChange: noopDisposable,
        onDidRemovePanel: noopDisposable,
        onDidAddPanel: noopDisposable,
        onDidActivePanelChange: noopDisposable,
        onDidMaximizedGroupChange: noopDisposable,
        // popout 文档跟踪(trackPopoutDocuments)。
        onDidAddGroup: noopDisposable,
        onDidRemoveGroup: noopDisposable,
        groups: [],
      };
      h.api = self;
      return self;
    }, []);
    React.useEffect(() => {
      onReady({ api });
    }, [api, onReady]);
    return React.createElement('div', { 'data-testid': 'dockview' });
  },
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    layout: {
      read: h.read,
      write: vi.fn().mockResolvedValue({ ok: true }),
      onFlushRequest: h.onFlushRequest,
    },
    terminal: { remove: vi.fn().mockResolvedValue({ ok: true }) },
    system: { windowId: 1 },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: vi.fn() } }));
vi.mock('@/lib/persist/explorer-persist', () => ({
  flushExplorerPersistence: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/panels/Editor/autosave-flush-registry', () => ({
  flushPendingAutoSave: vi.fn().mockResolvedValue(undefined),
}));

import { DockShell, DOCK_TERMINAL_READY_TIMEOUT_MS } from '@/shell/dock/DockShell';

// 活动面板为 settings 的持久布局(fake fromJSON 按 key 顺序重建,最后一个即活动面板)。
const layoutWithSettingsActive = {
  grid: {
    root: {
      type: 'branch',
      data: [{ type: 'leaf', data: { views: ['editor'], activeView: 'editor', id: '1' }, size: 700 }],
      size: 800,
    },
    width: 1400,
    height: 800,
    orientation: 'HORIZONTAL',
  },
  panels: {
    editor: { id: 'editor', contentComponent: 'editor' },
    settings: { id: 'settings', contentComponent: 'settings' },
  },
};

const panelIds = () => h.api?.panels.map((p) => p.id) ?? [];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

beforeEach(() => {
  __resetReconcilerForTest();
  h.read.mockReset();
  h.onFlushRequest.mockClear();
  h.api = null;
  useTerminalStore.setState({ sessions: [], hydrated: false, settled: false });
});

describe('Splash 就绪屏障:布局恢复 + 终端首个快照', () => {
  it('布局已恢复但终端快照未到 → 不报 ready;快照到达后才报,且存量终端已建好 panel', async () => {
    const onLayoutReady = vi.fn();
    h.read.mockResolvedValue({ ok: true, data: layoutWithSettingsActive });
    render(React.createElement(DockShell, { onLayoutReady }));
    await vi.waitFor(() => expect(panelIds()).toContain('settings'));
    await act(async () => {});
    expect(onLayoutReady).not.toHaveBeenCalled();

    act(() => {
      useTerminalStore
        .getState()
        .replaceSnapshot([makeSession('s1', { originHint: 'user', createdAt: 1 })]);
    });
    await vi.waitFor(() => expect(onLayoutReady).toHaveBeenCalled());
    expect(panelIds()).toContain('terminal-s1');
  });

  it('迟到的首个快照里的存量 user 终端不抢 fromJSON 恢复的活动面板', async () => {
    h.read.mockResolvedValue({ ok: true, data: layoutWithSettingsActive });
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(panelIds()).toContain('settings'));
    act(() => {
      useTerminalStore
        .getState()
        .replaceSnapshot([makeSession('s1', { originHint: 'user', createdAt: 1 })]);
    });
    expect(panelIds()).toContain('terminal-s1');
    expect(h.api!.activePanel?.id).toBe('settings');
  });

  it('首个快照后再新建的 user 终端照旧聚焦', async () => {
    h.read.mockResolvedValue({ ok: true, data: layoutWithSettingsActive });
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(panelIds()).toContain('settings'));
    act(() => {
      useTerminalStore
        .getState()
        .replaceSnapshot([makeSession('s1', { originHint: 'user', createdAt: 1 })]);
    });
    act(() => {
      useTerminalStore.getState().replaceSnapshot([
        ...useTerminalStore.getState().sessions,
        makeSession('s2', { originHint: 'user', createdAt: Date.now() + 1 }),
      ]);
    });
    expect(h.api!.activePanel?.id).toBe('terminal-s2');
  });

  it('首个快照为空(无终端)也解除屏障', async () => {
    const onLayoutReady = vi.fn();
    h.read.mockResolvedValue({ ok: true, data: layoutWithSettingsActive });
    render(React.createElement(DockShell, { onLayoutReady }));
    await vi.waitFor(() => expect(panelIds()).toContain('settings'));
    act(() => {
      useTerminalStore.getState().replaceSnapshot([]);
      useTerminalStore.getState().markHydrated();
    });
    await vi.waitFor(() => expect(onLayoutReady).toHaveBeenCalled());
  });

  it('终端同步已结算(初始拉取失败,settled)→ 解除屏障;之后首个快照的存量 user 终端仍不抢焦', async () => {
    const onLayoutReady = vi.fn();
    h.read.mockResolvedValue({ ok: true, data: layoutWithSettingsActive });
    render(React.createElement(DockShell, { onLayoutReady }));
    await vi.waitFor(() => expect(panelIds()).toContain('settings'));
    act(() => useTerminalStore.getState().markSettled());
    await vi.waitFor(() => expect(onLayoutReady).toHaveBeenCalled());

    act(() => {
      useTerminalStore
        .getState()
        .replaceSnapshot([makeSession('s1', { originHint: 'user', createdAt: 1 })]);
    });
    expect(panelIds()).toContain('terminal-s1');
    expect(h.api!.activePanel?.id).toBe('settings');
  });

  it('终端快照先于布局恢复到达 → 布局恢复即报 ready', async () => {
    const onLayoutReady = vi.fn();
    useTerminalStore.setState({
      sessions: [makeSession('s1', { createdAt: 1 })],
      hydrated: true,
    });
    h.read.mockResolvedValue({ ok: true, data: layoutWithSettingsActive });
    render(React.createElement(DockShell, { onLayoutReady }));
    await vi.waitFor(() => expect(onLayoutReady).toHaveBeenCalled());
    expect(panelIds()).toContain('terminal-s1');
  });

  it('终端快照迟迟不到 → 安全上限后仍报 ready(不永久遮挡)', async () => {
    vi.useFakeTimers();
    const onLayoutReady = vi.fn();
    h.read.mockResolvedValue({ ok: true, data: layoutWithSettingsActive });
    render(React.createElement(DockShell, { onLayoutReady }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(panelIds()).toContain('settings');
    expect(onLayoutReady).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCK_TERMINAL_READY_TIMEOUT_MS);
    });
    expect(onLayoutReady).toHaveBeenCalled();
  });
});
