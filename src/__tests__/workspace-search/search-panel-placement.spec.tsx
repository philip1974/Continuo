// @vitest-environment jsdom
// BDD: workspace-search / 1a 面板落点 —— 新建的搜索面板放在主窗 dock 网格最左侧的独立组(VSCode 侧栏位置),已存在只聚焦不挪动;
// 只含搜索面板的组不接收从主窗入口新建的其它面板。见同目录 README。真实 dockview(jsdom)+ 假 popout 子窗。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DockviewApi, IDockviewGroupPanel } from 'dockview-react';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { __resetSearchForTest } from '@/panels/Search/search-store';
import { markDockLayoutRestored, openOrFocusPanel, setDockApi } from '@/shell/dock/dock-api-ref';
import { mainWindowAddPosition, trackGroupMru } from '@/shell/dock/group-mru';
import { keepSidePanelWidth, SIDE_PANEL_MIN_WIDTH } from '@/shell/dock/side-panel-width';
import { HeaderActions } from '@/shell/dock/HeaderActions';
import { resetDockLayout } from '@/shell/dock/layout.default';
import { toggleSettingsPanel } from '@/lib/toggle-settings-panel';
import { SIDEBAR_DEFAULT_WIDTH, useLayoutUiStore } from '@/stores/layout-ui.store';
import { t } from '@/i18n';
import { createDock, openFakePopout } from '../dock-terminal-vscode-focus/dock-fixtures';

const FIND_IN_FILES = 'workbench.action.findInFiles';
let mru: { dispose(): void } | null = null;
let widths: { dispose(): void } | null = null;

beforeEach(() => {
  bootCorePlugins();
  useLayoutUiStore.setState({ sidebarOpen: true });
});
afterEach(async () => {
  cleanup();
  mru?.dispose();
  mru = null;
  widths?.dispose();
  widths = null;
  setDockApi(null);
  await shutdownCorePlugins();
  __resetSearchForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function dockWith(...ids: string[]) {
  const dock = createDock();
  dock.layout(1200, 800);
  const api = dock.api as DockviewApi;
  ids.forEach((id, i) => {
    api.addPanel({ id, component: id.startsWith('editor') ? 'editor' : id, title: id, ...(i > 0 ? { position: { direction: 'right' } } : {}) });
  });
  mru = trackGroupMru(api);
  widths = keepSidePanelWidth(api);
  setDockApi(api);
  markDockLayoutRestored(api);
  return { dock, api };
}

const findInFiles = () => coApp.commands.getAll().find((c) => c.id === FIND_IN_FILES)!.fn();
const search = (api: DockviewApi) => api.getPanel('search');

/** 主窗网格从左到右的叶子组(序列化网格树深度优先),每组的面板 id。 */
function gridLeaves(api: DockviewApi): string[][] {
  const out: string[][] = [];
  const walk = (node: { type: string; data: unknown }) => {
    if (node.type === 'leaf') out.push((node.data as { views: string[] }).views);
    else for (const c of node.data as { type: string; data: unknown }[]) walk(c);
  };
  walk(api.toJSON().grid.root as { type: string; data: unknown });
  return out.filter((v) => v.length > 0);
}

describe('新建搜索面板:主窗网格最左侧的独立组', () => {
  it('只有一个编辑器组 → 搜索单独成组放在编辑器左侧(不与编辑器叠在同组),宽为侧栏默认宽,成为活动面板', async () => {
    const { api } = dockWith('editor');
    await findInFiles();
    const panel = search(api)!;
    expect(panel).toBeDefined();
    expect(panel.group).not.toBe(api.getPanel('editor')!.group);
    expect(gridLeaves(api)).toEqual([['search'], ['editor']]);
    expect(panel.group.api.width).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(api.activePanel).toBe(panel);
  });

  it('已有多组(编辑器 | 编辑器 | 终端)、活动组在右侧 → 仍放在全部组的最左侧', async () => {
    const { api } = dockWith('editor', 'editor:2', 'terminal-1');
    api.getPanel('terminal-1')!.api.setActive();
    await findInFiles();
    expect(gridLeaves(api)).toEqual([['search'], ['editor'], ['editor:2'], ['terminal-1']]);
  });

  it('活动组在 popout 子窗 → 建在主窗最左侧,不进子窗', async () => {
    const { dock, api } = dockWith('editor', 'terminal-1');
    await openFakePopout(dock, 'terminal-1');
    api.getPanel('terminal-1')!.api.setActive();
    expect(api.activeGroup?.api.location.type).toBe('popout');
    await findInFiles();
    expect(search(api)!.api.location.type).toBe('grid');
    expect(gridLeaves(api)[0]).toEqual(['search']);
  });

  it('关闭后再打开 → 重新放回最左侧独立组', async () => {
    const { api } = dockWith('editor');
    await findInFiles();
    search(api)!.api.close();
    await vi.waitFor(() => expect(search(api)).toBeUndefined());
    api.getPanel('editor')!.api.setActive();
    await findInFiles();
    expect(gridLeaves(api)).toEqual([['search'], ['editor']]);
  });

  it('组右上「⋯」菜单 → 搜索:同样放在最左侧独立组,不落进该组', async () => {
    const { api } = dockWith('editor');
    const group = api.getPanel('editor')!.group as IDockviewGroupPanel;
    render(<HeaderActions {...({ containerApi: api, group, activePanel: group.activePanel } as unknown as Parameters<typeof HeaderActions>[0])} />);
    fireEvent.click(screen.getByRole('button', { name: t('panels.explorer.btn.more_actions') }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: /^(搜索|Search|검색)/ }));
    });
    expect(gridLeaves(api)).toEqual([['search'], ['editor']]);
  });
});

describe('已存在的搜索面板:只聚焦,不挪动', () => {
  it('用户把它拖进编辑器组 → 再执行命令只激活它,仍在编辑器组', async () => {
    const { api } = dockWith('editor');
    await findInFiles();
    const editorGroup = api.getPanel('editor')!.group;
    search(api)!.api.moveTo({ group: editorGroup, position: 'center' });
    api.getPanel('editor')!.api.setActive();
    await findInFiles();
    expect(search(api)!.group).toBe(editorGroup);
    expect(gridLeaves(api)).toHaveLength(1);
    expect(api.activePanel).toBe(search(api));
  });

  it('在 popout 子窗里 → 留在子窗', async () => {
    const { dock, api } = dockWith('editor');
    await findInFiles();
    await openFakePopout(dock, 'search');
    api.getPanel('editor')!.api.setActive();
    await findInFiles();
    expect(search(api)!.api.location.type).toBe('popout');
  });
});

describe('只含搜索面板的组不接收主窗入口新建的其它面板', () => {
  it('活动组是搜索组 → 主窗落点改投编辑器所在组;⌘, 设置落在编辑器组', async () => {
    const { api } = dockWith('editor');
    await findInFiles();
    expect(api.activeGroup).toBe(search(api)!.group);
    expect(mainWindowAddPosition(api)).toEqual({ referenceGroup: api.getPanel('editor')!.group, direction: 'within' });
    toggleSettingsPanel();
    expect(api.getPanel('settings')!.group).toBe(api.getPanel('editor')!.group);
  });

  it('主窗只剩搜索组(编辑器已关)→ 在搜索组右侧新建一组', async () => {
    const { api } = dockWith('editor');
    await findInFiles();
    api.getPanel('editor')!.api.close();
    await vi.waitFor(() => expect(api.getPanel('editor')).toBeUndefined());
    expect(api.activeGroup).toBe(search(api)!.group);
    openOrFocusPanel('output', 'output', 'Output');
    expect(gridLeaves(api)).toEqual([['search'], ['output']]);
  });

  it('搜索组里还有用户放进去的其它面板 → 不再视为侧栏组(落点照旧是活动组)', async () => {
    const { api } = dockWith('editor');
    await findInFiles();
    api.getPanel('editor')!.api.moveTo({ group: search(api)!.group, position: 'center' });
    search(api)!.api.setActive();
    expect(mainWindowAddPosition(api)).toBeUndefined();
  });
});

describe('重置布局', () => {
  it('搜索面板(被拖进编辑器组)回到最左侧独立组,编辑器仍为活动面板', async () => {
    const { api } = dockWith('editor', 'editor:2');
    await findInFiles();
    search(api)!.api.moveTo({ group: api.getPanel('editor:2')!.group, position: 'center' });
    resetDockLayout(api);
    expect(gridLeaves(api)).toEqual([['search'], ['editor'], ['editor:2']]);
    expect(search(api)!.group.api.width).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

// 第五十二轮审计 A3 / B:侧栏组保持自身宽度(VSCode 侧栏 LayoutPriority.Low,最小宽 170;编辑区先缩到 220)
describe('搜索组保持自身宽度', () => {
  /** 等 dockview 的布局变化事件(微任务合并派发)与校正后的再一轮。 */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  const width = (api: DockviewApi): number => search(api)!.group.api.width;

  it('主窗只剩搜索组时新开面板 → 在它右侧新建组,搜索组仍是原来的宽(不被劈成一半)', async () => {
    const { api } = dockWith('editor');
    await findInFiles();
    await settle();
    api.getPanel('editor')!.api.close();
    await vi.waitFor(() => expect(api.getPanel('editor')).toBeUndefined());
    await settle();
    api.addPanel({ id: 'terminal-1', component: 'terminal', title: 'terminal-1', position: mainWindowAddPosition(api) });
    await settle();
    expect(gridLeaves(api)).toEqual([['search'], ['terminal-1']]);
    expect(width(api)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('窗口缩放 → 搜索组宽不变,编辑区吸收;变窄时编辑区先缩到 220,之后搜索组才缩,最窄 170;放宽后回到原宽', async () => {
    const { dock, api } = dockWith('editor');
    await findInFiles();
    await settle();
    expect(search(api)!.group.minimumWidth).toBe(SIDE_PANEL_MIN_WIDTH);
    for (const [w, expected] of [
      [720, SIDEBAR_DEFAULT_WIDTH],
      [1600, SIDEBAR_DEFAULT_WIDTH],
      [420, 200],
      [300, SIDE_PANEL_MIN_WIDTH],
      [1200, SIDEBAR_DEFAULT_WIDTH],
    ] as const) {
      dock.layout(w, 800);
      await settle();
      expect(width(api), `dock ${w}`).toBe(expected);
    }
  });

  it('用户拖分隔条改的宽被记住,之后窗口缩放 / 增删组都保持它', async () => {
    const { dock, api } = dockWith('editor');
    await findInFiles();
    await settle();
    search(api)!.group.api.setSize({ width: 360 });
    await settle();
    dock.layout(900, 800);
    await settle();
    expect(width(api)).toBe(360);
    api.addPanel({ id: 'editor:2', component: 'editor', title: 'editor:2', position: { referenceGroup: api.getPanel('editor')!.group, direction: 'right' } });
    await settle();
    expect(width(api)).toBe(360);
  });
});
