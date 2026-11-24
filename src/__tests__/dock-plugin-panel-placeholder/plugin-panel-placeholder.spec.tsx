// @vitest-environment jsdom
// 数据丢失:持久化布局含尚未注册(插件晚到 / 已卸载)的面板类型时,恢复不得抛错丢掉整份布局。行为见同目录 README。
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DockviewReact, type DockviewApi, type SerializedDockview } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({ coApi: {} }));

import { setLocale } from '@/i18n/translate';
import { createScopedApp } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import { createPanelComponents } from '../../shell/dock/panel-components';

// jsdom 无 ResizeObserver;真 dockview 构造时要用(尺寸变化与本规范无关,空实现即可)。
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

afterEach(cleanup);

const PLACEHOLDER = /^Plugin panel not loaded\./;

/** 一个 group 里两个面板:内置 `core-panel` 与插件面板 `git.viewer`(插件尚未注册)。 */
const LAYOUT: SerializedDockview = {
  grid: {
    root: {
      type: 'branch',
      data: [
        {
          type: 'leaf',
          data: { id: 'g1', views: ['core-1', 'plugin-1'], activeView: 'plugin-1' },
          size: 400,
        },
      ],
      size: 300,
    },
    width: 400,
    height: 300,
    orientation: 'HORIZONTAL' as SerializedDockview['grid']['orientation'],
  },
  panels: {
    'core-1': { id: 'core-1', contentComponent: 'core-panel', title: 'Core' },
    'plugin-1': { id: 'plugin-1', contentComponent: 'git.viewer', title: 'Git Changes' },
  },
  activeGroup: 'g1',
};

function setup() {
  setLocale('en');
  const coApp = createTestCoApp('1.0.0');
  coApp.panels.register({ type: 'core-panel', title: 'Core', factory: () => <div>core content</div> });
  let api: DockviewApi | null = null;
  function Host(): React.ReactElement {
    const components = React.useMemo(() => createPanelComponents(coApp.panels, coApp.panels.getAll()), []);
    return (
      <div style={{ width: 400, height: 300 }}>
        <DockviewReact components={components} onReady={(e) => (api = e.api)} />
      </div>
    );
  }
  render(<Host />);
  return { coApp, api: () => api! };
}

describe('布局含未注册的插件面板类型', () => {
  it('fromJSON 不抛,其它面板保留,插件面板显示占位', () => {
    const { api } = setup();
    expect(() => act(() => api().fromJSON(LAYOUT))).not.toThrow();
    expect(api().panels.map((p) => p.id).sort()).toEqual(['core-1', 'plugin-1']);
    expect(screen.getByText(PLACEHOLDER)).toBeTruthy();
  });

  it('toJSON 仍保留插件面板(写盘不会被默认布局覆盖)', () => {
    const { api } = setup();
    act(() => api().fromJSON(LAYOUT));
    const json = api().toJSON();
    expect(json.panels['plugin-1']?.contentComponent).toBe('git.viewer');
    expect(json.panels['core-1']?.contentComponent).toBe('core-panel');
  });

  it('插件随后注册该类型 → 占位自动切换为真实内容;再注销 → 回到占位', () => {
    const { coApp, api } = setup();
    act(() => api().fromJSON(LAYOUT));
    let handle: { dispose(): void } | undefined;
    act(() => {
      handle = createScopedApp(coApp, 'git', null, 'token-git').panels.register({
        type: 'git.viewer',
        title: 'Git Changes',
        factory: () => <div>git content</div>,
      });
    });
    expect(screen.getByText('git content')).toBeTruthy();
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();
    act(() => handle!.dispose());
    expect(screen.queryByText('git content')).toBeNull();
    expect(screen.getByText(PLACEHOLDER)).toBeTruthy();
  });
});
