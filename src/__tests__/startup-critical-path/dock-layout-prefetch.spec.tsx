// @vitest-environment jsdom
// 性能(冷启动关键路径):layout.read(main 端读+解析+Zod explorer.json)在 renderer init() 开头即预取,
// DockShell 首次 onReady 消费该结果;之后的 onReady(StrictMode / dockview 重建)照旧重新读取,不复用旧结果。
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';

type Api = ReturnType<typeof makeApi>;

const h = vi.hoisted(() => ({
  read: vi.fn(),
  onReady: { current: null as ((e: { api: unknown }) => unknown) | null },
}));

function makeApi() {
  return {
    totalPanels: 1,
    fromJSON: vi.fn(),
    toJSON: vi.fn(() => ({ panels: {} })),
    getPanel: vi.fn(() => null),
    addPanel: vi.fn(() => ({ api: { setActive: vi.fn() } })),
    onDidLayoutChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidRemovePanel: vi.fn(() => ({ dispose: vi.fn() })),
    onDidAddPanel: vi.fn(() => ({ dispose: vi.fn() })),
    onDidMaximizedGroupChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidActivePanelChange: vi.fn(() => ({ dispose: vi.fn() })),
    panels: [],
  };
}

vi.mock('dockview-react', async () => {
  const { createElement } = await import('react');
  return {
    DockviewReact: ({ onReady }: { onReady: (event: { api: unknown }) => unknown }) => {
      h.onReady.current = onReady;
      return createElement('div', { 'data-testid': 'dockview' });
    },
  };
});

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
import { prefetchDockLayout, readDockLayout } from '@/shell/dock/layout-prefetch';

function layout(view: string) {
  return {
    grid: {
      root: {
        type: 'branch',
        data: [{ type: 'leaf', data: { views: [view], activeView: view, id: '1' }, size: 800 }],
        size: 800,
      },
      width: 1400,
      height: 800,
      orientation: 'HORIZONTAL',
    },
    panels: { [view]: { contentComponent: view } },
  };
}

function restoredView(api: Api): string | undefined {
  const arg = api.fromJSON.mock.calls[0]?.[0] as { panels?: Record<string, unknown> } | undefined;
  return arg?.panels ? Object.keys(arg.panels)[0] : undefined;
}

beforeEach(() => {
  h.read.mockReset();
  h.onReady.current = null;
  // 清掉上一个用例可能遗留的未消费预取
  h.read.mockResolvedValue({ ok: true, data: null });
  void readDockLayout().catch(() => {});
  h.read.mockReset();
});

describe('layout-prefetch 模块', () => {
  it('预取只被消费一次;之后的读取重新发起 IPC', async () => {
    h.read.mockResolvedValueOnce({ ok: true, data: 'A' }).mockResolvedValueOnce({ ok: true, data: 'B' });
    prefetchDockLayout();
    expect(h.read).toHaveBeenCalledTimes(1);
    await expect(readDockLayout()).resolves.toEqual({ ok: true, data: 'A' });
    expect(h.read).toHaveBeenCalledTimes(1);
    await expect(readDockLayout()).resolves.toEqual({ ok: true, data: 'B' });
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('layout.read 同步抛错 → 预取与读取都以 rejected promise 呈现(调用方 try/catch 兜底,与原 await 一致)', async () => {
    h.read.mockImplementation(() => {
      throw new Error('bridge missing');
    });
    expect(() => prefetchDockLayout()).not.toThrow();
    await expect(readDockLayout()).rejects.toThrow('bridge missing');
    await expect(readDockLayout()).rejects.toThrow('bridge missing');
  });
});

describe('DockShell 消费预取布局', () => {
  it('首次 onReady 使用预取结果(不再发 IPC);第二次 onReady 重新读取', async () => {
    h.read
      .mockResolvedValueOnce({ ok: true, data: layout('editor') })
      .mockResolvedValueOnce({ ok: true, data: layout('output') });
    prefetchDockLayout(); // init() 开头发起
    expect(h.read).toHaveBeenCalledTimes(1);

    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(h.onReady.current).not.toBeNull());

    const api1 = makeApi();
    await h.onReady.current!({ api: api1 });
    expect(h.read).toHaveBeenCalledTimes(1); // 消费预取,无新 IPC
    expect(restoredView(api1)).toBe('editor');

    // dockview 重建 / StrictMode 重入:不复用旧预取,重新读取
    const api2 = makeApi();
    await h.onReady.current!({ api: api2 });
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(restoredView(api2)).toBe('output');
  });

  it('无预取(如 HMR 重挂)→ onReady 照常发起 layout.read', async () => {
    h.read.mockResolvedValue({ ok: true, data: layout('editor') });
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(h.onReady.current).not.toBeNull());
    const api = makeApi();
    await h.onReady.current!({ api });
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(restoredView(api)).toBe('editor');
  });
});
