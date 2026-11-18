// @vitest-environment jsdom
// 安全:第三方插件注册的面板 factory 只拿到最小 props,拿不到 dockview 的 containerApi。行为见同目录 README。
import { render } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({ coApi: {} }));

import { createScopedApp } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import type { CoApp, PluginPanelProps } from '../../plugins/types';
import { createPanelComponents } from '../../shell/dock/panel-components';

/** dockview 原始面板 props 的替身:带 containerApi 与完整 panel api。 */
function makeDockviewProps(): {
  props: IDockviewPanelProps;
  setVisible: (v: boolean) => void;
  listeners: Set<(e: { isVisible: boolean }) => void>;
} {
  const listeners = new Set<(e: { isVisible: boolean }) => void>();
  let visible = true;
  const api = {
    id: 'panel-1',
    get isVisible() {
      return visible;
    },
    onDidVisibilityChange(cb: (e: { isVisible: boolean }) => void) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    close: vi.fn(),
    setTitle: vi.fn(),
    group: { panels: [] },
  };
  const props = {
    api,
    containerApi: { panels: [], toJSON: vi.fn(), clear: vi.fn(), addPanel: vi.fn() },
    params: { sessionId: 'secret-session' },
  } as unknown as IDockviewPanelProps;
  return {
    props,
    listeners,
    setVisible: (v) => {
      visible = v;
      // dockview 的事件对象带额外字段,回调只应看到 isVisible。
      for (const cb of [...listeners]) cb({ isVisible: v, extra: 'internal' } as { isVisible: boolean });
    },
  };
}

function renderPanel(coApp: CoApp, type: string, props: IDockviewPanelProps): void {
  const Component = createPanelComponents(coApp.panels, coApp.panels.getAll())[type]!;
  render(<Component {...props} />);
}

describe('第三方插件面板:factory 只收到 PluginPanelProps', () => {
  function setup(): { coApp: CoApp; received: PluginPanelProps[] } {
    const coApp = createTestCoApp('1.0.0');
    const received: PluginPanelProps[] = [];
    createScopedApp(coApp, 'evil', null, 'token-evil').panels.register({
      type: 'evil-panel',
      title: 'Evil',
      factory: (p) => {
        received.push(p as PluginPanelProps);
        return null;
      },
    });
    return { coApp, received };
  }

  it('没有 containerApi / params,api 只有 id / isVisible / onDidVisibilityChange', () => {
    const { coApp, received } = setup();
    const { props } = makeDockviewProps();
    renderPanel(coApp, 'evil-panel', props);

    const got = received[0] as unknown as Record<string, unknown>;
    expect(got).not.toBe(props);
    expect(Reflect.ownKeys(got)).toEqual(['api']);
    expect(got.containerApi).toBeUndefined();
    expect(got.params).toBeUndefined();
    const api = got.api as Record<string, unknown>;
    expect(api).not.toBe(props.api);
    expect(Reflect.ownKeys(api).sort()).toEqual(['id', 'isVisible', 'onDidVisibilityChange']);
    expect(api.close).toBeUndefined();
    expect(api.group).toBeUndefined();
    expect(Object.getPrototypeOf(api)).toBe(Object.prototype);
    expect(Object.isFrozen(got)).toBe(true);
    expect(Object.isFrozen(api)).toBe(true);
  });

  it('最小 api 可用:id、实时 isVisible、可见性订阅与退订(git viewer 的可见性门控依赖它)', () => {
    const { coApp, received } = setup();
    const { props, setVisible, listeners } = makeDockviewProps();
    renderPanel(coApp, 'evil-panel', props);
    const api = received[0]!.api;

    expect(api.id).toBe('panel-1');
    expect(api.isVisible).toBe(true);
    const seen: unknown[] = [];
    const sub = api.onDidVisibilityChange((e) => seen.push(e));
    setVisible(false);
    expect(api.isVisible).toBe(false);
    expect(seen).toEqual([{ isVisible: false }]);
    sub.dispose();
    expect(listeners.size).toBe(0);
    setVisible(true);
    expect(seen).toHaveLength(1);
  });

  it('同一面板多次渲染 → 同一个 props 对象(可作 effect 依赖)', () => {
    const { coApp, received } = setup();
    const { props } = makeDockviewProps();
    const Component = createPanelComponents(coApp.panels, coApp.panels.getAll())['evil-panel']!;
    const { rerender } = render(<Component {...props} />);
    rerender(<Component {...props} />);
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[1]).toBe(received[0]);
    expect(received[1]!.api).toBe(received[0]!.api);
  });
});

describe('宿主 / 内置插件面板:照旧收到 dockview 原始 props', () => {
  it('宿主直接注册', () => {
    const coApp = createTestCoApp('1.0.0');
    const factory = vi.fn((_props: unknown) => null);
    coApp.panels.register({ type: 'terminal', title: 'Terminal', factory });
    const { props } = makeDockviewProps();
    renderPanel(coApp, 'terminal', props);
    const got = factory.mock.calls[0]![0] as IDockviewPanelProps;
    expect(got.containerApi).toBe(props.containerApi);
    expect(got.api).toBe(props.api);
    expect(got.params).toBe(props.params);
  });

  it('内置插件(不带 token 的 scoped app)注册', () => {
    const coApp = createTestCoApp('1.0.0');
    const factory = vi.fn((_props: unknown) => null);
    createScopedApp(coApp, 'core.settings-panel', null).panels.register({ type: 'settings', title: 'S', factory });
    const { props } = makeDockviewProps();
    renderPanel(coApp, 'settings', props);
    expect((factory.mock.calls[0]![0] as IDockviewPanelProps).containerApi).toBe(props.containerApi);
  });
});

describe('已注销的面板 type', () => {
  it('插件停用后仍被渲染 → 空,不调用旧 factory', () => {
    const coApp = createTestCoApp('1.0.0');
    const factory = vi.fn((_props: unknown) => null);
    const handle = createScopedApp(coApp, 'p', null, 'token-p').panels.register({ type: 'p-panel', title: 'P', factory });
    const components = createPanelComponents(coApp.panels, coApp.panels.getAll());
    handle.dispose();
    const { props } = makeDockviewProps();
    const Component = components['p-panel']!;
    render(<Component {...props} />);
    expect(factory).not.toHaveBeenCalled();
  });
});
