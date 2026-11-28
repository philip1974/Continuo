// @vitest-environment jsdom
// BDD: entry-discoverability 第 4 条 —— 活动栏「搜索」「运行和调试」激活态:对应面板在主窗正显示 → aria-pressed=true(左侧主色条),
// 再点收起(关掉该面板,同资源管理器图标收起侧栏;VSCode ViewContainerActivityAction 默认 toggle);未显示 → 点击执行打开命令。
// 真实 dockview(jsdom)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DockviewApi } from 'dockview-react';

vi.mock('@/lib/toggle-settings-panel', () => ({ toggleSettingsPanel: vi.fn() }));

import { coApp } from '@/plugins/co-app';
import { CommandRegistry } from '@/plugins/registries/CommandRegistry';
import { RibbonRegistry } from '@/plugins/registries/RibbonRegistry';
import { setLocale } from '@/i18n';
import { IconSidebar } from '@/shell/IconSidebar';
import { markDockLayoutRestored, setDockApi } from '@/shell/dock/dock-api-ref';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { createDock, openFakePopout } from '../dock-terminal-vscode-focus/dock-fixtures';

const ran: string[] = [];
let originalCommands: CommandRegistry;
let originalRibbon: RibbonRegistry;

beforeEach(() => {
  setLocale('zh');
  ran.length = 0;
  originalCommands = coApp.commands;
  originalRibbon = coApp.ribbon;
  (coApp as { ribbon: RibbonRegistry }).ribbon = new RibbonRegistry();
  const commands = new CommandRegistry('other');
  for (const id of ['explorer.toggleSidebar', 'settings.toggle', 'workbench.action.findInFiles', 'workbench.view.debug']) {
    commands.register({ id, title: id, fn: () => void ran.push(id) });
  }
  (coApp as { commands: CommandRegistry }).commands = commands;
  useLayoutUiStore.setState({ sidebarOpen: true });
});
afterEach(() => {
  cleanup();
  setDockApi(null);
  (coApp as { commands: CommandRegistry }).commands = originalCommands;
  (coApp as { ribbon: RibbonRegistry }).ribbon = originalRibbon;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  setLocale('en');
});

const flush = () => act(async () => {});

function setup() {
  const dock = createDock();
  const api = dock.api as DockviewApi;
  api.layout(1200, 600, true);
  setDockApi(api);
  markDockLayoutRestored(api);
  render(<IconSidebar />);
  const search = () => screen.getByRole('button', { name: '搜索' });
  const debug = () => screen.getByRole('button', { name: '运行和调试' });
  return { dock, api, search, debug };
}

describe('活动栏「搜索」「运行和调试」激活态', () => {
  it('面板不存在 → aria-pressed=false,点击执行打开命令', async () => {
    const { search, debug } = setup();
    expect(search().getAttribute('aria-pressed')).toBe('false');
    expect(debug().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(search());
    fireEvent.click(debug());
    await flush();
    expect(ran).toEqual(['workbench.action.findInFiles', 'workbench.view.debug']);
  });

  it('面板在主窗正显示 → aria-pressed=true;被同组别的 tab 遮住 → false', async () => {
    const { api, search, debug } = setup();
    act(() => {
      api.addPanel({ id: 'search', component: 'search', title: 'Search' });
      api.addPanel({ id: 'debug', component: 'debug', title: 'Debug', position: { referencePanel: 'search', direction: 'right' } });
    });
    await flush();
    expect(search().getAttribute('aria-pressed')).toBe('true');
    expect(debug().getAttribute('aria-pressed')).toBe('true');
    act(() => {
      api.addPanel({ id: 'editor', component: 'editor', title: 'a.ts', position: { referencePanel: 'debug' } });
    });
    await flush();
    expect(debug().getAttribute('aria-pressed')).toBe('false');
    expect(search().getAttribute('aria-pressed')).toBe('true');
    act(() => api.getPanel('debug')!.api.setActive());
    await flush();
    expect(debug().getAttribute('aria-pressed')).toBe('true');
  });

  it('再点已激活的图标 → 收起(关掉该面板),不再执行打开命令', async () => {
    const { api, search } = setup();
    act(() => {
      api.addPanel({ id: 'search', component: 'search', title: 'Search' });
      api.addPanel({ id: 'editor', component: 'editor', title: 'a.ts', position: { referencePanel: 'search', direction: 'right' } });
    });
    await flush();
    expect(search().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(search());
    await flush();
    expect(api.getPanel('search')).toBeUndefined();
    expect(api.getPanel('editor')).toBeDefined();
    expect(ran).toEqual([]);
    expect(search().getAttribute('aria-pressed')).toBe('false');
  });

  it('面板在 popout 子窗 → 不算本窗口可见(aria-pressed=false),点击执行打开命令(在其所在窗口激活)', async () => {
    const { dock, api, debug } = setup();
    act(() => {
      api.addPanel({ id: 'editor', component: 'editor', title: 'a.ts' });
      api.addPanel({ id: 'debug', component: 'debug', title: 'Debug', position: { referencePanel: 'editor', direction: 'right' } });
    });
    await flush();
    expect(debug().getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      await openFakePopout(dock, 'debug');
    });
    await flush();
    expect(debug().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(debug());
    await flush();
    expect(ran).toEqual(['workbench.view.debug']);
  });

  it('别的组最大化遮住面板 → false;还原 → true', async () => {
    const { api, search } = setup();
    act(() => {
      api.addPanel({ id: 'search', component: 'search', title: 'Search' });
      api.addPanel({ id: 'editor', component: 'editor', title: 'a.ts', position: { referencePanel: 'search', direction: 'right' } });
    });
    await flush();
    act(() => api.getPanel('editor')!.group.api.maximize());
    await flush();
    expect(search().getAttribute('aria-pressed')).toBe('false');
    act(() => api.exitMaximizedGroup());
    await flush();
    expect(search().getAttribute('aria-pressed')).toBe('true');
  });
});
