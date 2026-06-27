// BDD: 22-pane-zoom-toggle / main toggle + command registration
//
// 用 fake DockviewApi 测 toggleActiveTerminalZoom guard-first 逻辑(P1-1)
// 与 onDidMaximizedGroupChange focus 派发(P0-3 + P2-1)。
// 不引真实 dockview — 主路径只依赖 4 个 API 字段。
//
// Test matrix (plan-v3):
//   T1     command 注册 + hotkey
//   T1b    getDockApi()===null → fn 直接 return
//   T2     activePanel terminal+grid + hasMax=false → maximizeGroup
//   T3     activePanel terminal+grid + hasMax=true → exit
//   T4-undef        activePanel undefined → no-op
//   T4-explorer     contentComponent='explorer' → no-op
//   T4-floating     location.type='floating' → no-op
//   T4-popout       location.type='popout' → no-op
//   T4-edge         location.type='edge' → no-op
//   T4e (P1-1)      hasMax=true + non-terminal active → exit 0 次 (guard-first)
//   T6 (P2-1)       isMaximized=false + terminal → focusTerminalPanel called
//   T6c (P2-1)      isMaximized=true → focusTerminalPanel 0 次
//   T9              i18n 三 catalog 全有 commands.terminal.zoom.title

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toggleActiveTerminalZoom } from '@/shell/dock/terminal-panel-zoom';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

// ────────────────────────────────────────────────────────────
// fake DockviewApi minimal shape
// ────────────────────────────────────────────────────────────

type LocationType = 'grid' | 'floating' | 'popout' | 'edge';

interface FakePanel {
  id: string;
  view: { contentComponent: string };
  api: { location: { type: LocationType } };
}

function makeApi(opts: {
  activePanel?: FakePanel;
  hasMaxed?: boolean;
}) {
  const maximize = vi.fn();
  const exit = vi.fn();
  return {
    api: {
      activePanel: opts.activePanel,
      hasMaximizedGroup: () => opts.hasMaxed ?? false,
      maximizeGroup: maximize,
      exitMaximizedGroup: exit,
    } as unknown as Parameters<typeof toggleActiveTerminalZoom>[0],
    maximize,
    exit,
  };
}

function termPanel(id = 'terminal-1', loc: LocationType = 'grid'): FakePanel {
  return {
    id,
    view: { contentComponent: 'terminal' },
    api: { location: { type: loc } },
  };
}

// ────────────────────────────────────────────────────────────
// T1 / T1b — command registration
// ────────────────────────────────────────────────────────────

// Plugin base class 需要 app: CoPluginApp + manifest: PluginManifest 构造。
// 这里只想 onload() 后捕获 addCommand 调用,所以做最小桩。
interface CapturedCommand {
  id: string;
  hotkey?: string;
  titleKey?: string;
  fn?: () => void | Promise<void>;
}

function makePluginApp() {
  const captured: CapturedCommand[] = [];
  const fakeApp = {
    commands: { register: (spec: CapturedCommand) => {
      captured.push(spec);
      return { dispose: () => {} };
    }},
    panels: { register: (_spec: unknown) => ({ dispose: () => {} }) },
    statusBar: { register: () => ({ dispose: () => {} }) },
    ribbon: { register: () => ({ dispose: () => {} }) },
    events: { on: () => ({ dispose: () => {} }) },
    dataStore: { read: async () => null, write: async () => undefined },
  };
  const fakeManifest = { id: 'continuo.terminal', name: 'Terminal' };
  return { fakeApp, fakeManifest, captured };
}

describe('TerminalPlugin command registration (T1)', () => {
  it('terminal.zoom.toggle 注册 + hotkey = shift+mod+enter + titleKey', async () => {
    const TerminalPluginModule = await import('@/core-plugins/TerminalPlugin');
    const TerminalPluginClass = TerminalPluginModule.default;
    const { fakeApp, fakeManifest, captured } = makePluginApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = new TerminalPluginClass(fakeApp as any, fakeManifest as any);
    plugin.onload();
    const zoomSpec = captured.find((c) => c.id === 'terminal.zoom.toggle');
    expect(zoomSpec).toBeDefined();
    expect(zoomSpec?.hotkey).toBe('shift+mod+enter');
    expect(zoomSpec?.titleKey).toBe('commands.terminal.zoom.title');
  });
});

describe('terminal.zoom.toggle fn null api guard (T1b)', () => {
  it('getDockApi()===null → fn 直接 return,toggle 0 次调用', async () => {
    vi.resetModules();
    vi.doMock('@/shell/dock/dock-api-ref', () => ({
      getDockApi: () => null,
      setDockApi: vi.fn(),
      focusPanel: vi.fn(),
      openOrFocusPanel: vi.fn(),
    }));
    const toggleSpy = vi.fn();
    vi.doMock('@/shell/dock/terminal-panel-zoom', () => ({
      toggleActiveTerminalZoom: toggleSpy,
    }));

    const TerminalPluginModule = await import('@/core-plugins/TerminalPlugin');
    const TerminalPluginClass = TerminalPluginModule.default;
    const { fakeApp, fakeManifest, captured } = makePluginApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = new TerminalPluginClass(fakeApp as any, fakeManifest as any);
    plugin.onload();
    const zoomSpec = captured.find((c) => c.id === 'terminal.zoom.toggle');
    expect(zoomSpec?.fn).toBeDefined();
    await zoomSpec?.fn?.();
    expect(toggleSpy).not.toHaveBeenCalled();
    vi.resetModules();
    vi.doUnmock('@/shell/dock/dock-api-ref');
    vi.doUnmock('@/shell/dock/terminal-panel-zoom');
  });
});

// ────────────────────────────────────────────────────────────
// T2 / T3 — toggle happy path
// ────────────────────────────────────────────────────────────

describe('toggleActiveTerminalZoom happy path', () => {
  it('T2: terminal+grid + hasMax=false → maximizeGroup(panel)', () => {
    const panel = termPanel();
    const { api, maximize, exit } = makeApi({ activePanel: panel, hasMaxed: false });
    toggleActiveTerminalZoom(api);
    expect(maximize).toHaveBeenCalledWith(panel);
    expect(exit).not.toHaveBeenCalled();
  });

  it('T3: terminal+grid + hasMax=true → exitMaximizedGroup', () => {
    const panel = termPanel();
    const { api, maximize, exit } = makeApi({ activePanel: panel, hasMaxed: true });
    toggleActiveTerminalZoom(api);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(maximize).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// T4 — guard no-op
// ────────────────────────────────────────────────────────────

describe('toggleActiveTerminalZoom guard (T4 family)', () => {
  it('T4-undef: activePanel undefined → no-op', () => {
    const { api, maximize, exit } = makeApi({ activePanel: undefined });
    toggleActiveTerminalZoom(api);
    expect(maximize).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('T4-explorer: view.contentComponent="explorer" → no-op', () => {
    const panel: FakePanel = {
      id: 'explorer',
      view: { contentComponent: 'explorer' },
      api: { location: { type: 'grid' } },
    };
    const { api, maximize, exit } = makeApi({ activePanel: panel });
    toggleActiveTerminalZoom(api);
    expect(maximize).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('T4-floating: location.type="floating" → no-op', () => {
    const panel = termPanel('terminal-fl', 'floating');
    const { api, maximize, exit } = makeApi({ activePanel: panel });
    toggleActiveTerminalZoom(api);
    expect(maximize).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('T4-popout: location.type="popout" → no-op', () => {
    const panel = termPanel('terminal-po', 'popout');
    const { api, maximize, exit } = makeApi({ activePanel: panel });
    toggleActiveTerminalZoom(api);
    expect(maximize).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('T4-edge: location.type="edge" → no-op', () => {
    const panel = termPanel('terminal-ed', 'edge');
    const { api, maximize, exit } = makeApi({ activePanel: panel });
    toggleActiveTerminalZoom(api);
    expect(maximize).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  // T4e (P1-1 critical): hasMaximizedGroup=true + active 非 terminal panel
  // — toggle 必须 guard-first,不能把别人的 maximized group exit 掉
  it('T4e (P1-1): hasMax=true + activePanel non-terminal → exit 0 次', () => {
    const panel: FakePanel = {
      id: 'editor',
      view: { contentComponent: 'editor' },
      api: { location: { type: 'grid' } },
    };
    const { api, maximize, exit } = makeApi({ activePanel: panel, hasMaxed: true });
    toggleActiveTerminalZoom(api);
    expect(exit).not.toHaveBeenCalled();
    expect(maximize).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// T9 — i18n
// ────────────────────────────────────────────────────────────

describe('i18n catalog 三套 commands.terminal.zoom.title (T9)', () => {
  it('en: Toggle Terminal Zoom', () => {
    expect(en['commands.terminal.zoom.title']).toBe('Toggle Terminal Zoom');
  });
  it('zh: 切换终端缩放', () => {
    expect(zh['commands.terminal.zoom.title']).toBe('切换终端缩放');
  });
  it('ko: 터미널 확대/축소 전환', () => {
    expect(ko['commands.terminal.zoom.title']).toBe('터미널 확대/축소 전환');
  });
});

// ────────────────────────────────────────────────────────────
// T6 / T6c — DockShell.onDidMaximizedGroupChange focus dispatch
// ────────────────────────────────────────────────────────────

// 这一组直接测 "exit-maximize → focusTerminalPanel(group.activePanel.id) 调用,
// enter-maximize → 不调"。不引 DockShell 整个 React 树,只复刻 onReady 内的
// 订阅 fn 行为。

describe('onDidMaximizedGroupChange focus dispatch (T6 / T6c)', () => {
  beforeEach(async () => {
    const mod = await import('@/panels/Terminal/terminal-focus-registry');
    mod.__resetTerminalFocusRegistryForTest();
  });

  it('T6: isMaximized=false + group.activePanel terminal → focusTerminalPanel called', async () => {
    const { registerTerminalFocus, focusTerminalPanel } = await import(
      '@/panels/Terminal/terminal-focus-registry'
    );
    const fn = vi.fn();
    registerTerminalFocus('terminal-foo', fn);

    // simulate DockShell onDidMaximizedGroupChange handler
    const handler = (evt: {
      isMaximized: boolean;
      group: { activePanel?: { id: string; contentComponent: string } };
    }) => {
      if (evt.isMaximized) return;
      const panel = evt.group.activePanel;
      if (!panel) return;
      if (panel.contentComponent !== 'terminal') return;
      focusTerminalPanel(panel.id);
    };

    handler({
      isMaximized: false,
      group: { activePanel: { id: 'terminal-foo', contentComponent: 'terminal' } },
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('T6c (P2-1): isMaximized=true → focusTerminalPanel 0 次 (避免二次 focus)', async () => {
    const { registerTerminalFocus, focusTerminalPanel } = await import(
      '@/panels/Terminal/terminal-focus-registry'
    );
    const fn = vi.fn();
    registerTerminalFocus('terminal-bar', fn);

    const handler = (evt: {
      isMaximized: boolean;
      group: { activePanel?: { id: string; contentComponent: string } };
    }) => {
      if (evt.isMaximized) return;
      const panel = evt.group.activePanel;
      if (!panel) return;
      if (panel.contentComponent !== 'terminal') return;
      focusTerminalPanel(panel.id);
    };

    handler({
      isMaximized: true, // ← 进 zoom 时不调
      group: { activePanel: { id: 'terminal-bar', contentComponent: 'terminal' } },
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('exit-maximize + group.activePanel 非 terminal → focusTerminalPanel 0 次', async () => {
    const { registerTerminalFocus, focusTerminalPanel } = await import(
      '@/panels/Terminal/terminal-focus-registry'
    );
    const fn = vi.fn();
    registerTerminalFocus('editor', fn);

    const handler = (evt: {
      isMaximized: boolean;
      group: { activePanel?: { id: string; contentComponent: string } };
    }) => {
      if (evt.isMaximized) return;
      const panel = evt.group.activePanel;
      if (!panel) return;
      if (panel.contentComponent !== 'terminal') return;
      focusTerminalPanel(panel.id);
    };

    handler({
      isMaximized: false,
      group: { activePanel: { id: 'editor', contentComponent: 'editor' } },
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// T7b — sanitize layout (delegated to existing DockShell sanitize fn)
// ────────────────────────────────────────────────────────────

describe('sanitizePersistedDockLayout terminal layout stripped (T7b)', () => {
  it('snapshot 含 terminal panel → 剥离终端,保留 editor 布局(不再整体弃用/不报错)', async () => {
    const { sanitizePersistedDockLayout } = await import('@/shell/dock/DockShell');
    const snapshot = {
      grid: {
        root: {
          type: 'branch',
          data: [
            {
              type: 'leaf',
              data: { views: ['editor', 'terminal-1'], activeView: 'terminal-1', id: '1' },
              size: 700,
            },
            {
              type: 'leaf',
              data: { views: ['terminal-2'], activeView: 'terminal-2', id: '2' },
              size: 700,
            },
          ],
          size: 800,
        },
        width: 1400,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: {
        editor: { contentComponent: 'editor' },
        'terminal-1': { contentComponent: 'terminal' },
        'terminal-2': { contentComponent: 'terminal' },
      },
      activeGroup: '2', // 指向只含终端的 group → 应被回退清除
    };
    const out = sanitizePersistedDockLayout(snapshot) as {
      panels: Record<string, unknown>;
      grid: { root: { data: Array<{ data: { views: string[]; activeView?: string } }> } };
      activeGroup?: string;
    };
    expect(out).not.toBeNull();
    // 终端 panel 被剥离,editor 保留
    expect(Object.keys(out.panels)).toEqual(['editor']);
    // 只含终端的 group "2" 被摘除 → root 仅剩 1 个 leaf
    expect(out.grid.root.data).toHaveLength(1);
    const leaf = out.grid.root.data[0].data;
    expect(leaf.views).toEqual(['editor']);
    // activeView 原指向 terminal-1 → 回退到 editor
    expect(leaf.activeView).toBe('editor');
    // 悬空 activeGroup("2" 已摘除)被清除
    expect(out.activeGroup).toBeUndefined();
  });

  it('snapshot 仅含 terminal panel(无非终端残留)→ 返回 null(走默认)', async () => {
    const { sanitizePersistedDockLayout } = await import('@/shell/dock/DockShell');
    const snapshot = {
      grid: {
        root: {
          type: 'branch',
          data: [{ type: 'leaf', data: { views: ['terminal-1'], id: '1' }, size: 800 }],
          size: 800,
        },
        width: 1400,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: { 'terminal-1': { contentComponent: 'terminal' } },
    };
    expect(sanitizePersistedDockLayout(snapshot)).toBeNull();
  });

  it('snapshot 不含 terminal panel → sanitize 不改变(返回原对象)', async () => {
    const { sanitizePersistedDockLayout } = await import('@/shell/dock/DockShell');
    const snapshot = {
      panels: {
        editor: { contentComponent: 'editor' },
        explorer: { contentComponent: 'explorer' },
      },
    };
    expect(sanitizePersistedDockLayout(snapshot)).toBe(snapshot);
  });

  // 边界(E217,E197/E199 有界迭代族 + E215 同族):panel 数超 MAX_LAYOUT_PANELS(256)→ 丢弃 layout
  // 返 null(走默认布局)。畸形 layout 即便在 2MiB 字节上限内仍可塞海量短 panel key。
  it('E217 panel 数超 MAX_LAYOUT_PANELS(256)→ sanitize 返回 null(丢弃走默认)', async () => {
    const { sanitizePersistedDockLayout } = await import('@/shell/dock/DockShell');
    const panels: Record<string, { contentComponent: string }> = {};
    for (let i = 0; i < 300; i++) panels[`p${i}`] = { contentComponent: 'editor' }; // 300 > 256
    expect(sanitizePersistedDockLayout({ panels })).toBeNull();
  });

  it('E217 panel 数在上限内(非终端)→ 不改变(回归)', async () => {
    const { sanitizePersistedDockLayout } = await import('@/shell/dock/DockShell');
    const panels: Record<string, { contentComponent: string }> = {};
    for (let i = 0; i < 200; i++) panels[`p${i}`] = { contentComponent: 'editor' }; // 200 < 256
    const snapshot = { panels };
    expect(sanitizePersistedDockLayout(snapshot)).toBe(snapshot);
  });
});
