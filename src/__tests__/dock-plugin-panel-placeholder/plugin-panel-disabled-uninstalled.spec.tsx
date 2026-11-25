// @vitest-environment jsdom
// BDD: dock-plugin-panel-placeholder —— 禁用 / 卸载后的插件面板(见同目录 README 末节)。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DockviewReact, type DockviewApi } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { state, mgr } = vi.hoisted(() => {
  const state = { list: [] as unknown[] };
  return { state, mgr: { listAll: () => state.list, enable: vi.fn(() => Promise.resolve()) } };
});
vi.mock('../../plugins/PluginManager', async () => {
  const { asSubscribableManager } = await import('../plugins-tab-content/fake-user-plugin-manager');
  return { getUserPluginManager: () => asSubscribableManager(mgr), setUserPluginManager: vi.fn() };
});
vi.mock('@/lib/co-api', () => ({ coApi: {} }));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { setLocale } from '@/i18n/translate';
import { createScopedApp } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import { createPanelComponents } from '../../shell/dock/panel-components';
import { notifyUserPluginListChanged } from '../plugins-tab-content/fake-user-plugin-manager';

afterEach(cleanup);

const entry = (status: string) => ({ id: 'acme.p', manifest: { id: 'acme.p', name: 'Acme P', version: '1.0.0' }, status });

function setup() {
  setLocale('en');
  state.list = [entry('enabled')];
  notifyUserPluginListChanged();
  const app = createTestCoApp('1.0.0');
  app.panels.register({ type: 'core-panel', title: 'Core', factory: () => <div>core content</div> });
  const reg = createScopedApp(app, 'acme.p', null, 'tok').panels.register({
    type: 'acme.p.view',
    title: 'P',
    factory: () => <div>plugin content</div>,
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
    api!.addPanel({ id: 'p-1', component: 'acme.p.view', title: 'P', position: { direction: 'right' } });
  });
  expect(screen.getByText('plugin content')).toBeTruthy();
  return { api: () => api!, unregister: () => act(() => reg.dispose()) };
}

function setList(list: unknown[]): void {
  act(() => {
    state.list = list;
    notifyUserPluginListChanged();
  });
}

describe('插件禁用后', () => {
  it('占位明确说明「已禁用」并给「启用」按钮(调 manager.enable)', () => {
    const { api, unregister } = setup();
    setList([entry('disabled')]);
    unregister();
    expect(screen.getByText('Plugin “Acme P” is disabled. Enable it to show this panel again.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    expect(mgr.enable).toHaveBeenCalledWith('acme.p');
    expect(api().panels.map((p) => p.id).sort()).toEqual(['core-1', 'p-1']);
  });
});

describe('插件卸载后', () => {
  it('关闭该插件 type 的面板,其它面板保留', () => {
    const { api, unregister } = setup();
    unregister();
    setList([]);
    expect(api().panels.map((p) => p.id)).toEqual(['core-1']);
    expect(screen.getByText('core content')).toBeTruthy();
  });
});

describe('从未见过所有者的未注册面板', () => {
  it('仍为通用占位,不因插件列表不含它而被关闭', () => {
    const { api } = setup();
    act(() => {
      api().addPanel({ id: 'x-1', component: 'never.seen', title: 'X', position: { direction: 'below' } });
    });
    setList([]);
    expect(api().panels.map((p) => p.id)).toContain('x-1');
    expect(screen.getByText(/^Plugin panel not loaded\./)).toBeTruthy();
  });
});
