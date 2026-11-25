// @vitest-environment jsdom
// BDD:弹出到独立窗口后面板内容获焦(VSCode:移到新窗口的编辑器直接获焦);源组随弹出被移除时 MRU 不激活同窗别的面板。
// 见同目录 README 第 2 条。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { t } from '@/i18n';
import { HeaderActions } from '@/shell/dock/HeaderActions';
import { trackGroupMru } from '@/shell/dock/group-mru';
import { coApp } from '@/plugins/co-app';
import { PanelRegistry } from '@/plugins/registries/PanelRegistry';

vi.mock('@/notifications/notify', () => ({ notify: { error: vi.fn() } }));

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

beforeEach(() => {
  (coApp as { panels: PanelRegistry }).panels = new PanelRegistry();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** 弹出后的面板替身:内容元素里有可编辑区(编辑器 / 终端输入区)。 */
function popoutPanel(isActive: boolean) {
  const element = document.createElement('div');
  const editable = document.createElement('textarea');
  element.appendChild(editable);
  document.body.appendChild(element);
  const panel: { id: string; view: { content: { element: HTMLElement } }; api: unknown } = {
    id: 'editor',
    view: { content: { element } },
    api: undefined,
  };
  panel.api = { id: 'editor', isActive, group: { panels: [panel] } };
  return { panel, editable };
}

function renderHeader(panel: unknown, addPopoutGroup: () => Promise<boolean>) {
  const props = {
    containerApi: { addPanel: vi.fn(), getPanel: vi.fn(), addPopoutGroup: vi.fn(addPopoutGroup) },
    group: { id: 'g1', api: { location: { type: 'grid' } } },
    activePanel: panel,
  };
  const { container } = render(<HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />);
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('shell.dock.popout_title')}"]`)!;
  return { button };
}

describe('弹出到独立窗口后面板内容获焦', () => {
  it('弹出成功、面板仍是活动面板 → 面板内容(可编辑区)获焦', async () => {
    const { panel, editable } = popoutPanel(true);
    const { button } = renderHeader(panel, () => Promise.resolve(true));
    button.focus();
    fireEvent.click(button);
    await flush();
    expect(document.activeElement).toBe(editable);
  });

  it('弹出失败(resolve false)→ 不动焦点', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { panel, editable } = popoutPanel(true);
    const { button } = renderHeader(panel, () => Promise.resolve(false));
    button.focus();
    fireEvent.click(button);
    await flush();
    expect(document.activeElement).not.toBe(editable);
  });

  it('弹出完成时面板已不是活动面板 → 不抢焦点', async () => {
    const { panel, editable } = popoutPanel(false);
    const { button } = renderHeader(panel, () => Promise.resolve(true));
    fireEvent.click(button);
    await flush();
    expect(document.activeElement).not.toBe(editable);
  });
});

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('源组随弹出被移除时 MRU 不激活同窗别的面板', () => {
  it('浮动组里唯一的编辑器弹出 → 主窗终端不被设为活动面板(否则终端激活时自己抢焦点)', async () => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const dock = new DockviewComponent(host, {
      createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
    });
    const api = dock.api as DockviewApi;
    api.addPanel({ id: 't', component: 'terminal', title: 't' });
    api.addPanel({ id: 'editor', component: 'editor', title: 'editor', floating: true });
    const tracker = trackGroupMru(api);
    api.getPanel('t')!.api.setActive();
    api.getPanel('editor')!.api.setActive();
    expect(api.getPanel('editor')!.api.location.type).toBe('floating');
    const terminalActivations: boolean[] = [];
    api.getPanel('t')!.api.onDidActiveChange((e) => terminalActivations.push(e.isActive));

    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const child = iframe.contentWindow!;
    vi.spyOn(window, 'open').mockImplementation(() => {
      queueMicrotask(() => child.dispatchEvent(new Event('load')));
      return child;
    });
    expect(await api.addPopoutGroup(api.getPanel('editor')!)).toBe(true);
    await flush();

    expect(api.getPanel('editor')!.api.location.type).toBe('popout');
    expect(api.activePanel?.id).toBe('editor');
    expect(terminalActivations).not.toContain(true);
    tracker.dispose();
  });
});
