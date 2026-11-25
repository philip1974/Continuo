// @vitest-environment jsdom
// BDD: plugin-render-isolation —— 插件贡献渲染抛错只影响它自己(见同目录 README)。
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DockviewReact, type DockviewApi } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mgr } = vi.hoisted(() => ({
  mgr: {
    listAll: () => [
      { id: 'acme.bad', manifest: { id: 'acme.bad', name: 'Acme Bad', version: '1.0.0' }, status: 'enabled' },
    ],
    markRenderFailed: vi.fn(),
    disable: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    enable: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('../../plugins/PluginManager', async () => {
  const { asSubscribableManager } = await import('../plugins-tab-content/fake-user-plugin-manager');
  return { getUserPluginManager: () => asSubscribableManager(mgr), setUserPluginManager: vi.fn() };
});
vi.mock('@/lib/co-api', () => ({ coApi: {} }));
vi.mock('../../shell/dock/dock-api-ref', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openOrFocusPanel: vi.fn(),
}));
vi.mock('../../lib/toggle-settings-panel', () => ({ toggleSettingsPanel: vi.fn() }));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { setLocale } from '@/i18n/translate';
import { coApp } from '../../plugins/co-app';
import { contributionPluginId, createScopedApp } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';
import { RibbonRegistry } from '../../plugins/registries/RibbonRegistry';
import { StatusBar } from '../../shell/StatusBar';
import { IconSidebar } from '../../shell/IconSidebar';
import { createPanelComponents } from '../../shell/dock/panel-components';
import { SettingsPanel } from '../../plugins/settings/SettingsPanel';
import { useSettingsStore } from '../../plugins/settings/store';
import { useWorkspaceStore } from '../../stores/workspace.store';

function Boom(): React.ReactElement {
  throw new Error('boom');
}

const INLINE_TITLE = 'Plugin “Acme Bad” failed to render';

beforeEach(() => {
  setLocale('en');
  mgr.markRenderFailed.mockClear();
  mgr.disable.mockClear();
  mgr.reload.mockClear();
  // React 对被边界接住的错误仍打 console.error;测试输出保持干净。
  vi.spyOn(console, 'error').mockImplementation(() => {});
  (coApp as { statusBar: StatusBarRegistry }).statusBar = new StatusBarRegistry();
  (coApp as { ribbon: RibbonRegistry }).ribbon = new RibbonRegistry();
  useWorkspaceStore.setState({ root: '/ws/project', recentRoots: [] });
  useSettingsStore.setState({ activeTabId: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pluginApp = () => createScopedApp(coApp, 'acme.bad', null, 'tok');

describe('状态栏项渲染抛错', () => {
  it('render() 返回的组件抛错:状态栏其余照常,该项显示紧凑错误图标(title 带插件名),插件标 failed', () => {
    pluginApp().statusBar.register({ id: 'acme.bad.item', side: 'left', render: () => <Boom /> });
    pluginApp().statusBar.register({ id: 'acme.bad.ok', side: 'right', render: () => 'fine item' });
    const { container } = render(<StatusBar />);
    expect(container.querySelector('footer')).not.toBeNull();
    expect(screen.getByText('project')).toBeTruthy();
    expect(screen.getByText('fine item')).toBeTruthy();
    expect(screen.getByTitle(INLINE_TITLE)).toBeTruthy();
    expect(mgr.markRenderFailed).toHaveBeenCalledWith('acme.bad', expect.any(Error));
  });

  it('render() 自身同步抛错同样就地显示错误图标并上报', () => {
    pluginApp().statusBar.register({
      id: 'acme.bad.sync',
      side: 'left',
      render: () => {
        throw new Error('sync');
      },
    });
    render(<StatusBar />);
    expect(screen.getByTitle(INLINE_TITLE)).toBeTruthy();
    expect(mgr.markRenderFailed).toHaveBeenCalledWith('acme.bad', expect.any(Error));
  });
});

describe('功能区图标渲染抛错', () => {
  it('图标替换成错误图标,按钮与侧栏其余照常', () => {
    pluginApp().ribbon.register({ id: 'acme.bad.ribbon', title: 'Bad Ribbon', icon: <Boom />, onClick: () => {} });
    render(<IconSidebar />);
    const btn = screen.getByRole('button', { name: 'Bad Ribbon' });
    expect(btn.querySelector(`[title="${INLINE_TITLE}"]`)).not.toBeNull();
    expect(mgr.markRenderFailed).toHaveBeenCalledWith('acme.bad', expect.any(Error));
  });
});

describe('面板 factory 渲染抛错', () => {
  function mountDock() {
    const app = createTestCoApp('1.0.0');
    app.panels.register({ type: 'core-panel', title: 'Core', factory: () => <div>core content</div> });
    createScopedApp(app, 'acme.bad', null, 'tok').panels.register({
      type: 'acme.bad.panel',
      title: 'Bad',
      factory: () => <Boom />,
    });
    let api: DockviewApi | null = null;
    function Host(): React.ReactElement {
      const components = React.useMemo(() => createPanelComponents(app.panels, app.panels.getAll()), []);
      return (
        <div style={{ width: 400, height: 300 }}>
          <DockviewReact components={components} onReady={(e) => (api = e.api)} />
        </div>
      );
    }
    render(<Host />);
    act(() => {
      api!.addPanel({ id: 'core-1', component: 'core-panel', title: 'Core' });
      api!.addPanel({ id: 'bad-1', component: 'acme.bad.panel', title: 'Bad', position: { direction: 'right' } });
    });
  }

  it('只有该面板显示错误块(带禁用 / 重载),其它面板照常', () => {
    mountDock();
    expect(screen.getByText('core content')).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(INLINE_TITLE);
    expect(mgr.markRenderFailed).toHaveBeenCalledWith('acme.bad', expect.any(Error));
    fireEvent.click(screen.getByRole('button', { name: 'Disable Plugin' }));
    expect(mgr.disable).toHaveBeenCalledWith('acme.bad');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(mgr.reload).toHaveBeenCalledWith('acme.bad');
  });
});

describe('设置页渲染抛错', () => {
  it('当前页内容显示错误块,左侧导航照常可切走', () => {
    const app = createTestCoApp('1.0.0');
    app.settingTabs.register({ id: 'general', title: 'General', render: () => 'general content', priority: 1 });
    createScopedApp(app, 'acme.bad', null, 'tok').settingTabs.register({
      id: 'acme.bad.tab',
      title: 'Bad Tab',
      render: () => <Boom />,
      priority: 2,
    });
    useSettingsStore.setState({ activeTabId: 'acme.bad.tab' });
    render(<SettingsPanel registry={app.settingTabs} itemRegistry={app.settingItems} />);
    expect(screen.getByRole('alert').textContent).toContain(INLINE_TITLE);
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.getByText('general content')).toBeTruthy();
  });

  it('导航图标抛错:只替换图标', () => {
    const app = createTestCoApp('1.0.0');
    createScopedApp(app, 'acme.bad', null, 'tok').settingTabs.register({
      id: 'acme.bad.tab',
      title: 'Bad Tab',
      icon: <Boom />,
      render: () => 'bad tab content',
    });
    render(<SettingsPanel registry={app.settingTabs} itemRegistry={app.settingItems} />);
    expect(screen.getByText('bad tab content')).toBeTruthy();
    expect(screen.getByTitle(INLINE_TITLE)).toBeTruthy();
  });
});

describe('其余第三方 ReactNode 渲染点都包了边界(源码钉)', () => {
  it.each([
    'src/panels/Editor/EditorHeader.tsx',
    'src/panels/Explorer/ContextMenu.tsx',
    'src/panels/Explorer/FileRow.tsx',
  ])('%s 用 PluginRenderBoundary 包插件 icon', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src).toMatch(/<PluginRenderBoundary[^>]*variant="inline"/);
  });
});

describe('贡献归属(渲染出错时上报给哪个插件)', () => {
  it('第三方 keyed 贡献与资源管理器装饰函数都能查到插件 id;内置 / 未登记 → null', () => {
    const app = createTestCoApp('1.0.0');
    const scoped = createScopedApp(app, 'acme.bad', null, 'tok');
    scoped.ribbon.register({ id: 'acme.bad.r', title: 'R', icon: 'x', onClick: () => {} });
    const decorator = () => null;
    scoped.explorerDecorators.register(decorator);
    createScopedApp(app, 'core.x', null).ribbon.register({ id: 'core.r', title: 'C', icon: 'x', onClick: () => {} });
    expect(contributionPluginId(app.ribbon.get('acme.bad.r')!)).toBe('acme.bad');
    expect(contributionPluginId(app.explorerDecorators.getAll()[0]!)).toBe('acme.bad');
    expect(contributionPluginId(app.ribbon.get('core.r')!)).toBeNull();
    expect(contributionPluginId({})).toBeNull();
  });
});
