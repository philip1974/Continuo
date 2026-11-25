// @vitest-environment jsdom
// Markdown(Milkdown)视图重挂载(切 tab / 切模式 / 外部修改重载)后恢复该 tab 的滚动位置。见同目录 README.md。
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mounted: [] as Array<() => void>,
  focus: null as null | ((...args: unknown[]) => void),
}));

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: {},
  Crepe: vi.fn().mockImplementation(() => {
    const view = {
      dom: document.createElement('div'),
      root: document,
      updateRoot: () => {},
      focus: () => h.focus?.(),
    };
    return {
      setReadonly: vi.fn(),
      editor: { ctx: { get: () => view }, config: () => {}, use: () => {} },
      on: (fn: (l: unknown) => void) =>
        fn({ mounted: (cb: () => void) => h.mounted.push(cb), updated: () => {} }),
    };
  }),
}));
vi.mock('@milkdown/react', () => ({
  Milkdown: () => <div data-testid="milkdown" />,
  MilkdownProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useEditor: (init: (root: HTMLElement) => unknown) => {
    const React_ = React;
    React_.useEffect(() => {
      init(document.createElement('div'));
    }, []);
  },
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { clearEditorViewStates } from '../../panels/Editor/editor-view-state-cache';
import { requestEditorFocus } from '../../panels/Editor/editor-focus-registry';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

function mount(tabId: string) {
  h.mounted = [];
  const r = render(<MilkdownEditor key={tabId} tabId={tabId} defaultValue="# hi" />);
  const scroller = r.container.querySelector('.overflow-auto') as HTMLElement;
  const ready = () => act(() => h.mounted.forEach((cb) => cb()));
  return { ...r, scroller, ready };
}

beforeEach(() => {
  clearEditorViewStates();
  h.focus = null;
  useEditorStore.setState({ tabs: [createTab('/w/a.md', '# hi'), createTab('/w/b.md', '# hi')], activeTabId: '/w/a.md' });
});
afterEach(() => cleanup());

describe('Milkdown 视图重挂载恢复滚动位置', () => {
  it('滚动后卸载,同 tab 重挂且编辑器就绪 → 恢复到原滚动位置', async () => {
    const first = mount('/w/a.md');
    first.ready();
    first.scroller.scrollTop = 420;
    fireEvent.scroll(first.scroller);
    first.unmount();

    const second = mount('/w/a.md');
    expect(second.scroller.scrollTop).toBe(0);
    second.ready();
    await nextFrame();
    expect(second.scroller.scrollTop).toBe(420);
  });

  it('各 tab 的滚动位置互不影响', async () => {
    const a = mount('/w/a.md');
    a.ready();
    a.scroller.scrollTop = 300;
    fireEvent.scroll(a.scroller);
    a.unmount();

    const b = mount('/w/b.md');
    b.ready();
    await nextFrame();
    expect(b.scroller.scrollTop).toBe(0);
  });

  it('重命名后以新 id 挂载 → 滚动位置跟随', async () => {
    const a = mount('/w/a.md');
    a.ready();
    a.scroller.scrollTop = 250;
    fireEvent.scroll(a.scroller);
    useEditorStore.getState().renamePath('/w/a.md', '/w/c.md');
    a.unmount();

    const c = mount('/w/c.md');
    c.ready();
    await nextFrame();
    expect(c.scroller.scrollTop).toBe(250);
  });

  it('编辑器就绪后可接收「聚焦该 tab」请求(就绪前发出的请求在就绪时兑现)', async () => {
    const focus = vi.fn();
    h.focus = focus;
    const a = mount('/w/a.md');
    requestEditorFocus('/w/a.md');
    await nextFrame();
    expect(focus).not.toHaveBeenCalled();
    a.ready();
    await nextFrame();
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
