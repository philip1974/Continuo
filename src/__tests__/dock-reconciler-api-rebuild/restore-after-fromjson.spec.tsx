// @vitest-environment jsdom
// race:DockShell onReady 异步恢复布局(await layout.read 较慢)期间,若 Reconciler 已挂载并把现有
// 终端 session 建成 panel,随后的 fromJSON(dockview 内部先 clear())会把它们清掉,而 Reconciler
// 认为已同步不再补加 → 终端从 UI 消失。契约:布局恢复(fromJSON / 默认布局)完成后,终端 panel
// 仍按 live session 全量存在。
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useTerminalStore } from '@/stores/terminal.store';
import { __resetReconcilerForTest } from '@/shell/dock/DockReconciler';
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
  api: null as null | { panels: FakePanel[] },
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
        // 真实 dockview fromJSON 先 clear() 再按 JSON 重建 —— 终端不在持久布局中
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
    layout: { read: h.read, write: vi.fn().mockResolvedValue({ ok: true }) },
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

import { DockShell } from '@/shell/dock/DockShell';

const persistedLayout = {
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
  panels: { editor: { id: 'editor', contentComponent: 'editor' } },
};

beforeEach(() => {
  __resetReconcilerForTest();
  h.read.mockReset();
  h.api = null;
  useTerminalStore.setState({
    sessions: [makeSession('s1', { originHint: 'user', createdAt: 1 })],
  });
});

describe('布局异步恢复后终端 panel 不丢失', () => {
  it('layout.read 慢 → fromJSON 清空 dock 之后,现有终端 session 仍有 panel', async () => {
    let resolveRead: (v: unknown) => void = () => {};
    h.read.mockReturnValue(
      new Promise((r) => {
        resolveRead = r;
      }),
    );
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(h.api).not.toBeNull());

    resolveRead({ ok: true, data: persistedLayout });
    await vi.waitFor(() => {
      const ids = h.api!.panels.map((p) => p.id);
      expect(ids).toContain('editor'); // 布局已恢复
      expect(ids).toContain('terminal-s1'); // 终端未被 fromJSON 清掉
    });
  });

  it('布局恢复完成后新增的 session 照常建 panel(Reconciler 订阅仍工作)', async () => {
    h.read.mockResolvedValue({ ok: true, data: persistedLayout });
    render(React.createElement(DockShell));
    await vi.waitFor(() =>
      expect(h.api?.panels.map((p) => p.id)).toContain('terminal-s1'),
    );
    useTerminalStore.setState({
      sessions: [
        ...useTerminalStore.getState().sessions,
        makeSession('s2', { createdAt: 2 }),
      ],
    });
    expect(h.api!.panels.map((p) => p.id)).toContain('terminal-s2');
  });
});
