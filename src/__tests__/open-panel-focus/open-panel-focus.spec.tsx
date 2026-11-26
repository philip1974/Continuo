// @vitest-environment jsdom
// BDD:用户打开 / 显示面板后焦点进面板(VSCode openView(id, focus=true);⌘, 总是聚焦设置搜索框)。见同目录 README 第 1 条。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { t } from '@/i18n';
import { markDockLayoutRestored, openOrFocusPanel, setDockApi } from '@/shell/dock/dock-api-ref';
import { showPanelOfType } from '@/shell/dock/dock-panel-actions';
import { focusPanelContent } from '@/shell/dock/panel-focus';
import { HeaderActions } from '@/shell/dock/HeaderActions';
import { toggleSettingsPanel } from '@/lib/toggle-settings-panel';
import { Output } from '@/panels/Output';
import { coApp } from '@/plugins/co-app';
import { PanelRegistry } from '@/plugins/registries/PanelRegistry';
import { useLayoutUiStore } from '@/stores/layout-ui.store';

vi.mock('@/notifications/notify', () => ({ notify: { error: vi.fn() } }));
vi.mock('@/shell/dock/create-user-terminal', () => ({ createUserTerminal: vi.fn() }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** 各类面板内容替身:终端(可编辑区)、设置(搜索框 + 导航按钮)、输出(只有根落点)、lazy(挂载前为空)。 */
function contentFor(name: string): HTMLElement {
  const el = document.createElement('div');
  if (name === 'terminal') el.appendChild(document.createElement('textarea'));
  if (name === 'settings' || name === 'plugin') {
    const search = document.createElement('input');
    search.dataset.role = 'search';
    el.appendChild(search);
    el.appendChild(document.createElement('button'));
  }
  if (name === 'output') {
    const root = document.createElement('div');
    root.tabIndex = -1;
    root.setAttribute('data-panel-focus-root', '');
    el.appendChild(root);
  }
  return el;
}

function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: (o) => ({ element: contentFor(o.name), init: () => {} }),
  });
  setDockApi(dock.api);
  markDockLayoutRestored(dock.api);
  return dock.api;
}

/** 主窗只有一个终端面板且焦点在终端输入区(缺陷复现起点)。 */
function dockWithFocusedTerminal() {
  const api = createDock();
  const term = api.addPanel({ id: 'term', component: 'terminal', title: 'zsh' });
  const textarea = term.view.content.element.querySelector('textarea')!;
  textarea.focus();
  return { api, term, textarea };
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
const contentOf = (api: DockviewApi, id: string) => api.getPanel(id)!.view.content.element;

beforeEach(() => {
  (coApp as { panels: PanelRegistry }).panels = new PanelRegistry();
  coApp.panels.register({ type: 'output', title: 'Output', multiInstance: true, factory: () => null });
  coApp.panels.register({ type: 'settings', title: 'Settings', factory: () => null });
  useLayoutUiStore.setState({ sidebarOpen: true });
});
afterEach(() => {
  cleanup();
  setDockApi(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('打开新面板 → 焦点进面板内容', () => {
  it('openOrFocusPanel 新建(⌘, / ⇧⌘F / 插件 openPanel 共用)→ 面板内容获焦,焦点离开终端', async () => {
    const { api, textarea } = dockWithFocusedTerminal();
    openOrFocusPanel('plugin', 'plugin', 'Plugin');
    await flush();
    expect(document.activeElement).not.toBe(textarea);
    expect(contentOf(api, 'plugin').contains(document.activeElement)).toBe(true);
  });

  it('内容稍后才渲染(lazy chunk 挂起中)→ 渲染出落点时获焦', async () => {
    const { api } = dockWithFocusedTerminal();
    openOrFocusPanel('lazy', 'lazy', 'Lazy');
    await flush();
    const content = contentOf(api, 'lazy');
    const input = document.createElement('input');
    content.appendChild(input); // 模拟 lazy 内容挂载
    await flush();
    expect(document.activeElement).toBe(input);
  });

  it('等待挂载期间用户按下指针(如点侧栏)→ 挂载后不抢焦点', async () => {
    const { api } = dockWithFocusedTerminal();
    const sidebarButton = document.body.appendChild(document.createElement('button'));
    openOrFocusPanel('lazy', 'lazy', 'Lazy');
    await flush();
    fireEvent.pointerDown(sidebarButton);
    sidebarButton.focus();
    contentOf(api, 'lazy').appendChild(document.createElement('input'));
    await flush();
    expect(document.activeElement).toBe(sidebarButton);
  });

  it('等待挂载期间用户激活了别的面板(另一组,lazy 面板仍可见)→ 挂载后不抢焦点', async () => {
    const { api, term } = dockWithFocusedTerminal();
    const other = api.addPanel({ id: 'other', component: 'plugin', title: 'Other', position: { direction: 'right' } });
    term.api.setActive();
    openOrFocusPanel('lazy', 'lazy', 'Lazy'); // 落在终端所在组
    await flush();
    other.api.setActive();
    const otherInput = other.view.content.element.querySelector('input')!;
    otherInput.focus();
    contentOf(api, 'lazy').appendChild(document.createElement('input'));
    await flush();
    expect(document.activeElement).toBe(otherInput);
  });

  it('面板已把焦点放进自己内容(autoFocus / 自己的 requestFocus)→ 不改到别的控件', async () => {
    const { api } = dockWithFocusedTerminal();
    openOrFocusPanel('plugin', 'plugin', 'Plugin');
    const own = contentOf(api, 'plugin').querySelector('button')!;
    own.focus(); // 面板挂载提交时自己聚焦(早于我们的微任务)
    await flush();
    expect(document.activeElement).toBe(own);
  });
});

describe('⌘, 重新激活后台 tab 里的设置 → 设置搜索框获焦', () => {
  it('设置在同组后台 tab、焦点在终端 → 激活并聚焦搜索框', async () => {
    const api = createDock();
    api.addPanel({ id: 'settings', component: 'settings', title: 'Settings' });
    const term = api.addPanel({ id: 'term', component: 'terminal', title: 'zsh' }); // 同组,设置退到后台
    term.view.content.element.querySelector('textarea')!.focus();
    toggleSettingsPanel();
    await flush();
    expect(api.activePanel?.id).toBe('settings');
    expect((document.activeElement as HTMLElement | null)?.dataset.role).toBe('search');
  });
});

describe('查看:显示输出', () => {
  it('没有输出面板 → 新建并聚焦(空输出面板落到根落点)', async () => {
    const { api } = dockWithFocusedTerminal();
    showPanelOfType('output');
    await flush();
    const output = api.panels.find((p) => p.view.contentComponent === 'output')!;
    expect(document.activeElement).toBe(output.view.content.element.querySelector('[data-panel-focus-root]'));
  });

  it('已有输出面板在后台 → 激活并聚焦', async () => {
    const api = createDock();
    const output = api.addPanel({ id: 'output-9', component: 'output', title: 'Output' });
    api.addPanel({ id: 'term', component: 'terminal', title: 'zsh' });
    api.getPanel('term')!.view.content.element.querySelector('textarea')!.focus();
    showPanelOfType('output');
    await flush();
    expect(api.activePanel).toBe(output);
    expect(output.view.content.element.contains(document.activeElement)).toBe(true);
  });
});

describe('dock「⋯」菜单', () => {
  it('选「输出」(多实例新建)→ 焦点进新输出面板,不落 body', async () => {
    const { api, term } = dockWithFocusedTerminal();
    render(
      <HeaderActions
        {...({ containerApi: api, group: term.group, activePanel: term } as unknown as Parameters<typeof HeaderActions>[0])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('panels.explorer.btn.more_actions') }));
    await flush();
    fireEvent.click(screen.getByRole('menuitem', { name: /Output/ }));
    await flush();
    const output = api.panels.find((p) => p.view.contentComponent === 'output')!;
    expect(output).toBeDefined();
    expect(output.view.content.element.contains(document.activeElement)).toBe(true);
  });
});

describe('空输出面板的根落点', () => {
  it('Output 没有任何控件 → focusPanelContent 落到 data-panel-focus-root', () => {
    const { container } = render(<Output />);
    const panel = { id: 'output-1', view: { content: { element: container } } };
    const api = { id: 'output-1', group: { panels: [panel] } };
    expect(focusPanelContent(api as never)).toBe(true);
    expect(document.activeElement).toBe(container.querySelector('[data-panel-focus-root]'));
  });
});
