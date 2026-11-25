// @vitest-environment jsdom
// 同组切换 dock 面板回来时内容滚动位置保持。行为见同目录 README。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { DockviewReact, type DockviewApi } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({ coApi: {} }));

import { setLocale } from '@/i18n/translate';
import { createTestCoApp } from '../../plugins/test-utils';
import { createPanelComponents } from '../../shell/dock/panel-components';
import { keepScrollWhileHidden } from '../../shell/dock/keep-scroll-while-hidden';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

afterEach(cleanup);

/** 浏览器把元素卸下再插回后滚动归零;jsdom 不模拟布局,手动归零。 */
function resetLikeDetach(el: HTMLElement): void {
  el.scrollTop = 0;
  el.scrollLeft = 0;
}

function scrollTo(el: HTMLElement, top: number, left = 0): void {
  el.scrollTop = top;
  el.scrollLeft = left;
  el.dispatchEvent(new Event('scroll'));
}

function setup() {
  setLocale('en');
  const coApp = createTestCoApp('1.0.0');
  const scroller = (testId: string) => (
    <div data-testid={testId} style={{ overflow: 'auto', height: 100 }}>
      <div style={{ height: 5000 }} />
    </div>
  );
  coApp.panels.register({ type: 'doc', title: 'Doc', factory: () => scroller('doc-scroller') });
  coApp.panels.register({ type: 'terminal', title: 'Terminal', factory: () => scroller('term-scroller') });
  coApp.panels.register({ type: 'other', title: 'Other', factory: () => <div>other</div> });
  let api: DockviewApi | null = null;
  function Host(): React.ReactElement {
    const components = React.useMemo(() => createPanelComponents(coApp.panels, coApp.panels.getAll()), []);
    return (
      <div style={{ width: 400, height: 300 }}>
        <DockviewReact components={components} onReady={(e) => (api = e.api)} />
      </div>
    );
  }
  const view = render(<Host />);
  return { api: () => api!, view };
}

describe('dock 面板同组切换 · 滚动保持', () => {
  it('滚到中段 → 切到同组别的面板 → 切回 → 滚动位置恢复', () => {
    const { api, view } = setup();
    act(() => {
      api().addPanel({ id: 'doc-1', component: 'doc', title: 'Doc' });
      api().addPanel({ id: 'other-1', component: 'other', title: 'Other', position: { referencePanel: 'doc-1', direction: 'within' } });
      api().getPanel('doc-1')!.api.setActive();
    });
    const el = view.getByTestId('doc-scroller');
    act(() => scrollTo(el, 1200, 30));
    act(() => api().getPanel('other-1')!.api.setActive());
    expect(el.isConnected).toBe(false); // dockview 卸下了内容 DOM
    resetLikeDetach(el);
    act(() => api().getPanel('doc-1')!.api.setActive());
    expect(el.isConnected).toBe(true);
    expect(el.scrollTop).toBe(1200);
    expect(el.scrollLeft).toBe(30);
  });

  it('终端面板不挂(xterm 自管视口)', () => {
    const { api, view } = setup();
    act(() => {
      api().addPanel({ id: 'term-1', component: 'terminal', title: 'Terminal' });
      api().addPanel({ id: 'other-1', component: 'other', title: 'Other', position: { referencePanel: 'term-1', direction: 'within' } });
      api().getPanel('term-1')!.api.setActive();
    });
    const el = view.getByTestId('term-scroller');
    act(() => scrollTo(el, 900));
    act(() => api().getPanel('other-1')!.api.setActive());
    resetLikeDetach(el);
    act(() => api().getPanel('term-1')!.api.setActive());
    expect(el.scrollTop).toBe(0);
  });
});

describe('keepScrollWhileHidden', () => {
  function fakeApi(isVisible = true) {
    let cb: ((e: { isVisible: boolean }) => void) | null = null;
    const dispose = vi.fn(() => {
      cb = null;
    });
    return {
      api: {
        isVisible,
        onDidVisibilityChange: (fn: (e: { isVisible: boolean }) => void) => {
          cb = fn;
          return { dispose };
        },
      },
      fire: (v: boolean) => cb?.({ isVisible: v }),
      dispose,
    };
  }

  function mount() {
    const root = document.createElement('div');
    const a = document.createElement('div');
    const b = document.createElement('div');
    root.append(a, b);
    document.body.appendChild(root);
    return { root, a, b };
  }

  it('隐藏期间派发的滚动事件(归零后的值)不记录', () => {
    const { root, a } = mount();
    const f = fakeApi();
    keepScrollWhileHidden(root, f.api);
    scrollTo(a, 500);
    f.fire(false);
    scrollTo(a, 0);
    f.fire(true);
    expect(a.scrollTop).toBe(500);
  });

  it('已脱离文档的元素派发的滚动事件不记录', () => {
    const { root, a } = mount();
    const f = fakeApi();
    keepScrollWhileHidden(root, f.api);
    scrollTo(a, 500);
    root.remove();
    scrollTo(a, 0);
    document.body.appendChild(root);
    f.fire(true);
    expect(a.scrollTop).toBe(500);
  });

  it('已从面板移除的元素不再恢复;各滚动容器分别恢复', () => {
    const { root, a, b } = mount();
    const f = fakeApi();
    keepScrollWhileHidden(root, f.api);
    scrollTo(a, 300);
    scrollTo(b, 700);
    a.remove();
    f.fire(false);
    resetLikeDetach(a);
    resetLikeDetach(b);
    f.fire(true);
    expect(a.scrollTop).toBe(0);
    expect(b.scrollTop).toBe(700);
  });

  it('注销后不再记录 / 恢复', () => {
    const { root, a } = mount();
    const f = fakeApi();
    const off = keepScrollWhileHidden(root, f.api);
    scrollTo(a, 300);
    off();
    expect(f.dispose).toHaveBeenCalledTimes(1);
    resetLikeDetach(a);
    f.fire(true);
    expect(a.scrollTop).toBe(0);
  });
});
