// @vitest-environment jsdom
// 打磨 R50(codex 性能,仿 R32/R33/R49):ExplorerSidebar 拆 shell + body。关闭状态
// (sidebarOpen=false)下 shell 直接返回 null,不挂载 ExplorerSidebarBody → 不订阅
// sidebarWidth、不创建 resize handler、不跑 useT。宽度变化不碰不可见 sidebar。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Profiler } from 'react';
import { render, cleanup, act } from '@testing-library/react';

vi.mock('../../panels/Explorer', () => ({
  Explorer: () => <div data-testid="explorer" />,
}));

import { ExplorerSidebar } from '../../shell/ExplorerSidebar';
import { useLayoutUiStore } from '../../stores/layout-ui.store';

beforeEach(() => {
  useLayoutUiStore.setState({ sidebarOpen: false, sidebarWidth: 280 });
});
afterEach(() => cleanup());

describe('打磨 R50 — Explorer 侧栏关闭时不订阅宽度', () => {
  it('关闭时改 sidebarWidth → shell 不重渲(body 未挂载)', () => {
    const onRender = vi.fn();
    const { container } = render(
      <Profiler id="es" onRender={onRender}>
        <ExplorerSidebar />
      </Profiler>,
    );
    const base = onRender.mock.calls.length;
    expect(container.querySelector('aside')).toBeNull(); // 关闭无 body

    act(() => {
      useLayoutUiStore.setState({ sidebarWidth: 400 });
    });

    expect(onRender.mock.calls.length).toBe(base); // 无新 commit
  });

  it('打开 → 挂载 body(aside + resize handle)', () => {
    const { container } = render(<ExplorerSidebar />);
    expect(container.querySelector('aside')).toBeNull();

    act(() => {
      useLayoutUiStore.setState({ sidebarOpen: true });
    });

    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(container.querySelector('[role=separator]')).not.toBeNull();
  });
});
