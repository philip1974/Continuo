// @vitest-environment jsdom
// race:DockShell onReady 异步恢复布局(await layout.read 较慢)期间,若 Reconciler 已挂载并把现有
// 终端 session 建成 panel,随后的 fromJSON(dockview 内部先 clear())会把它们清掉,而 Reconciler
// 认为已同步不再补加 → 终端从 UI 消失。契约:布局恢复(fromJSON / 默认布局)完成后,终端 panel
// 仍按 live session 全量存在。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useTerminalStore } from '@/stores/terminal.store';
import { __resetReconcilerForTest, setPendingFocus } from '@/shell/dock/DockReconciler';
import { openOrFocusPanel } from '@/shell/dock/dock-api-ref';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { makeSession } from '../dock-reconciler-windowid-filter/fixtures';

interface FakePanel {
  id: string;
  params: unknown;
  // 用户入口新建 / 激活面板后把焦点交给内容(addPanelAndFocus / revealDockPanel)要读的最小形态
  view: { content: { element: HTMLElement } };
  api: {
    group: { panels: FakePanel[] };
    id: string;
    title: string;
    setActive: () => void;
    close: () => void;
    setTitle: (t: string) => void;
    location: { type: 'grid' };
    onDidLocationChange: () => { dispose: () => void };
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
            view: { content: { element: document.createElement('div') } },
            api: {
              group: { panels },
              id: opts.id,
              title: opts.title ?? opts.id,
              // 主窗(grid)面板:DockShell 按主窗内面板数判空(isMainWindowDockEmpty)。
              location: { type: 'grid' },
              setActive: () => {
                self.activePanel = p;
              },
              close: () => {
                const i = panels.indexOf(p);
                if (i >= 0) panels.splice(i, 1);
              },
              setTitle: () => {},
              onDidLocationChange: () => ({ dispose: () => {} }),
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
        onDidActiveGroupChange: noopDisposable,
        // popout 文档跟踪(trackPopoutDocuments)。
        onDidAddGroup: noopDisposable,
        onDidRemoveGroup: noopDisposable,
        onWillDrop: noopDisposable,
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

// 活动面板为 settings 的持久布局(fake fromJSON 按 key 顺序重建,最后一个即活动面板)。
const layoutWithSettingsActive = {
  ...persistedLayout,
  panels: {
    editor: { id: 'editor', contentComponent: 'editor' },
    settings: { id: 'settings', contentComponent: 'settings' },
  },
};

function deferRead(): (v: unknown) => void {
  let resolveRead: (v: unknown) => void = () => {};
  h.read.mockReturnValue(
    new Promise((r) => {
      resolveRead = r;
    }),
  );
  return (v) => resolveRead(v);
}

afterEach(() => {
  cleanup();
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

beforeEach(() => {
  __resetReconcilerForTest();
  h.read.mockReset();
  h.onFlushRequest.mockClear();
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

// 恢复后才挂载 Reconciler:首次 reconcile 全量重建存量终端时,它们不是「刚创建」,不得 setActive 抢走
// fromJSON 恢复出的活动面板;之后真正新建的 user terminal 照旧聚焦。
describe('布局恢复后挂载 Reconciler 不抢活动面板', () => {
  it('存量 user terminal 重建后,活动面板仍是 fromJSON 恢复的那个', async () => {
    const resolveRead = deferRead();
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(h.api).not.toBeNull());

    resolveRead({ ok: true, data: layoutWithSettingsActive });
    await vi.waitFor(() =>
      expect(h.api!.panels.map((p) => p.id)).toContain('terminal-s1'),
    );
    expect(h.api!.activePanel?.id).toBe('settings');
  });

  it('恢复完成后新建的 user terminal 照旧聚焦', async () => {
    h.read.mockResolvedValue({ ok: true, data: layoutWithSettingsActive });
    render(React.createElement(DockShell));
    await vi.waitFor(() =>
      expect(h.api?.panels.map((p) => p.id)).toContain('terminal-s1'),
    );
    act(() => {
      useTerminalStore.setState({
        sessions: [
          ...useTerminalStore.getState().sessions,
          makeSession('s2', { originHint: 'user', createdAt: 2 }),
        ],
      });
    });
    expect(h.api!.activePanel?.id).toBe('terminal-s2');
  });

  // 恢复期间 Cmd+T:sessions-changed 先于 terminal.create reply 到达 → 新 session 在 Reconciler 挂载前已进
  // store,setPendingFocus 在挂载(首次 hydrate reconcile)之后才执行、无人消费。hydrate 只应抑制恢复开始前
  // 已存在的 session,恢复期间新建的 user terminal 照常走 originHint 兜底聚焦。
  it('恢复期间新建的 user terminal(pendingFocus 晚到)→ 恢复后仍聚焦它', async () => {
    const resolveRead = deferRead();
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(h.api).not.toBeNull());

    act(() => {
      useTerminalStore.setState({
        sessions: [
          ...useTerminalStore.getState().sessions,
          makeSession('s2', { originHint: 'user', createdAt: Date.now() }),
        ],
      });
    });
    resolveRead({ ok: true, data: layoutWithSettingsActive });
    await vi.waitFor(() =>
      expect(h.api!.panels.map((p) => p.id)).toContain('terminal-s2'),
    );
    setPendingFocus('s2'); // create reply 晚到:此时已无 reconcile 可消费它
    expect(h.api!.activePanel?.id).toBe('terminal-s2');
  });
});

// layout.read() 慢时 dock api 已暴露:恢复前 addPanel 的面板会被 fromJSON 的 clear() 删掉且不再补建。
// 契约:会 addPanel 的入口在布局恢复完成后才生效(排队 / 延后),关窗 flush 握手仍在 apiReady 时注册。
describe('布局恢复前的 addPanel 入口延后到恢复完成', () => {
  it('恢复前 openOrFocusPanel → 恢复后该面板存在', async () => {
    const resolveRead = deferRead();
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(h.api).not.toBeNull());

    openOrFocusPanel('plugin-x', 'plugin-x', 'Plugin X');
    resolveRead({ ok: true, data: persistedLayout });

    await vi.waitFor(() => {
      const ids = h.api!.panels.map((p) => p.id);
      expect(ids).toContain('editor');
      expect(ids).toContain('plugin-x');
    });
  });

  it('恢复前 editor 激活(activeTabId 变化)→ 恢复后 editor 面板存在', async () => {
    const resolveRead = deferRead();
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(h.api).not.toBeNull());

    act(() => {
      useEditorStore.setState({ activeTabId: 'tab-1' });
    });
    resolveRead({
      ok: true,
      data: {
        ...persistedLayout,
        panels: { settings: { id: 'settings', contentComponent: 'settings' } },
      },
    });

    await vi.waitFor(() => {
      const ids = h.api!.panels.map((p) => p.id);
      expect(ids).toContain('settings');
      expect(ids).toContain('editor');
    });
  });

  it('关窗 flush 握手在布局恢复前就已注册(时序不变)', async () => {
    deferRead();
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(h.onFlushRequest).toHaveBeenCalledTimes(1));
  });
});

// 布局恢复完成后 editor 自动激活 effect 的首次运行不是用户意图(activeTabId 来自持久化 hydrate):只确保 editor
// 面板存在,不得 setActive 覆盖 fromJSON 恢复的活动面板或恢复期间排队打开的面板;之后 editorFocusPulse 变化
//(用户打开 / 切换文件)才激活 editor。
describe('布局恢复后 editor 自动激活不抢活动面板', () => {
  it('持久化 activeTabId 非空 → 恢复后活动面板仍是 fromJSON 恢复的 settings', async () => {
    const resolveRead = deferRead();
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(h.api).not.toBeNull());
    act(() => {
      useEditorStore.setState({ activeTabId: 'tab-1' });
    });
    resolveRead({ ok: true, data: layoutWithSettingsActive });
    await vi.waitFor(() =>
      expect(h.api!.panels.map((p) => p.id)).toContain('terminal-s1'),
    );
    expect(h.api!.activePanel?.id).toBe('settings');
  });

  it('editor 面板缺失 → 补建但不抢激活;恢复期间排队打开的面板保持活动', async () => {
    const resolveRead = deferRead();
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(h.api).not.toBeNull());
    act(() => {
      useEditorStore.setState({ activeTabId: 'tab-1' });
    });
    openOrFocusPanel('plugin-x', 'plugin-x', 'Plugin X');
    resolveRead({
      ok: true,
      data: {
        ...persistedLayout,
        panels: { settings: { id: 'settings', contentComponent: 'settings' } },
      },
    });
    await vi.waitFor(() => {
      const ids = h.api!.panels.map((p) => p.id);
      expect(ids).toContain('editor');
      expect(ids).toContain('plugin-x');
    });
    expect(h.api!.activePanel?.id).toBe('plugin-x');
  });

  // VSCode:从主窗打开文件落在主窗。editor 面板已被关掉、活动组在 popout 子窗(用户最后点过子窗)时,补建的 editor
  // 不能落进活动组(子窗);主窗没有可用组 → 在主窗新建一组。BDD: src/__tests__/popout-open-target/
  it('editor 面板缺失且活动组在 popout 子窗 → 用户打开文件时 editor 补建在主窗,不进子窗', async () => {
    h.read.mockResolvedValue({
      ok: true,
      data: { ...persistedLayout, panels: { settings: { id: 'settings', contentComponent: 'settings' } } },
    });
    render(React.createElement(DockShell));
    await vi.waitFor(() => expect(h.api?.panels.map((p) => p.id)).toContain('terminal-s1'));
    const api = h.api as unknown as {
      activeGroup: unknown;
      groups: unknown[];
      addPanel: ReturnType<typeof vi.fn>;
    };
    const childDoc = document.implementation.createHTMLDocument('child');
    const popoutGroup = { id: 'pg', api: { location: { type: 'popout', getWindow: () => ({ document: childDoc }) } }, activePanel: undefined };
    api.activeGroup = popoutGroup;
    api.groups = [popoutGroup];
    act(() => {
      useEditorStore.getState().openTab(createTab('/proj/c.md', 'content'));
    });
    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'editor', position: { direction: 'right' } }),
    );
  });

  it('恢复后 editorFocusPulse 变化(用户切换文件)→ 激活 editor', async () => {
    useEditorStore.setState({ activeTabId: 'tab-1' });
    h.read.mockResolvedValue({ ok: true, data: layoutWithSettingsActive });
    render(React.createElement(DockShell));
    await vi.waitFor(() =>
      expect(h.api?.panels.map((p) => p.id)).toContain('terminal-s1'),
    );
    expect(h.api!.activePanel?.id).toBe('settings');
    act(() => {
      useEditorStore.getState().switchTab('tab-1');
    });
    expect(h.api!.activePanel?.id).toBe('editor');
  });
});

// 冷启动:layout.read() 先完成(Dock 已按 fromJSON 恢复),hydrateEditorTabs(读文件较慢)稍后才把持久化 editor
// tab 经 openTab / switchTab 恢复。会话恢复不是用户意图:不得 setActive 抢走 Dock 恢复出的活动面板;
// 恢复全部完成后的真实用户 openTab / switchTab 才激活 editor。
describe('editor 会话恢复晚于布局恢复', () => {
  async function restoreEditorSession(): Promise<void> {
    const { hydrateEditorTabs } = await vi.importActual<
      typeof import('@/lib/persist/explorer-persist')
    >('@/lib/persist/explorer-persist');
    useWorkspaceStore.setState({ root: '/proj' });
    await act(async () => {
      await hydrateEditorTabs(
        {
          version: 2,
          workspace: { recentRoots: [] },
          pinned: { paths: [] },
          nextWindowSeq: 1,
          windows: [
            {
              windowSeq: 0,
              workspace: { root: '/proj' },
              explorer: { activePath: null, expandedPaths: [], sort: { by: 'name', reverse: false } },
              editor: { openFilePaths: ['/proj/a.md', '/proj/b.md'], activePath: '/proj/a.md' },
            },
          ],
        },
        { readFile: async () => ({ ok: true as const, data: 'content' }) },
        0,
      );
    });
  }

  async function renderRestoredDock(layout: unknown): Promise<void> {
    h.read.mockResolvedValue({ ok: true, data: layout });
    render(React.createElement(DockShell));
    await vi.waitFor(() =>
      expect(h.api?.panels.map((p) => p.id)).toContain('terminal-s1'),
    );
    expect(h.api!.activePanel?.id).toBe('settings');
  }

  it('Dock 先恢复、editor tab 稍后恢复 → 活动面板仍是 settings,editor 面板存在', async () => {
    await renderRestoredDock(layoutWithSettingsActive);
    await restoreEditorSession();
    expect(useEditorStore.getState().activeTabId).toBe('/proj/a.md');
    expect(h.api!.panels.map((p) => p.id)).toContain('editor');
    expect(h.api!.activePanel?.id).toBe('settings');
  });

  it('editor 面板不在持久布局 → 稍后的会话恢复补建 editor,但激活还给 settings', async () => {
    await renderRestoredDock({
      ...persistedLayout,
      panels: { settings: { id: 'settings', contentComponent: 'settings' } },
    });
    await restoreEditorSession();
    expect(h.api!.panels.map((p) => p.id)).toContain('editor');
    expect(h.api!.activePanel?.id).toBe('settings');
  });

  it('恢复全部完成后用户 openTab → 激活 editor', async () => {
    await renderRestoredDock(layoutWithSettingsActive);
    await restoreEditorSession();
    act(() => {
      useEditorStore.getState().openTab(createTab('/proj/c.md', 'content'));
    });
    expect(h.api!.activePanel?.id).toBe('editor');
  });

  // 交错时序:Dock 恢复后、editor 会话恢复前,用户先打开文件(pulse 递增,editor 激活)再切回 settings;
  // 随后会话恢复以 requestFocus:false 改 activeTabId(pulse 不变)。已被消费的那次用户意图不得被再次当成意图。
  it('会话恢复前用户打开文件后切回 settings → 稍后的会话恢复不抢走 settings;再次点击同一文件仍激活 editor(#22)', async () => {
    await renderRestoredDock(layoutWithSettingsActive);
    act(() => {
      useEditorStore.getState().openTab(createTab('/proj/c.md', 'content'));
    });
    expect(h.api!.activePanel?.id).toBe('editor');
    act(() => {
      h.api!.panels.find((p) => p.id === 'settings')!.api.setActive();
    });
    await restoreEditorSession();
    expect(useEditorStore.getState().activeTabId).toBe('/proj/a.md');
    expect(h.api!.activePanel?.id).toBe('settings');

    // 同一文件再次点击(activeTabId 不变,只递增 pulse)→ 照常激活 editor。
    act(() => {
      useEditorStore.getState().switchTab('/proj/a.md');
    });
    expect(h.api!.activePanel?.id).toBe('editor');
    act(() => {
      h.api!.panels.find((p) => p.id === 'settings')!.api.setActive();
    });
    act(() => {
      useEditorStore.getState().switchTab('/proj/a.md');
    });
    expect(h.api!.activePanel?.id).toBe('editor');
  });

  it('恢复全部完成后用户 switchTab → 激活 editor', async () => {
    await renderRestoredDock(layoutWithSettingsActive);
    await restoreEditorSession();
    act(() => {
      useEditorStore.getState().switchTab('/proj/b.md');
    });
    expect(h.api!.activePanel?.id).toBe('editor');
  });
});
