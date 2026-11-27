// @vitest-environment jsdom
// 点非活动 dock tab 的标题:dockview 在 pointerdown 里激活面板,标题元素须保持同一节点,click 才会派发、焦点才进内容。
// 行为见同目录 README。
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedTab } from '../../shell/motion/SharedTab';

afterEach(cleanup);

function makeApi() {
  let activeCb: ((e: { isActive: boolean }) => void) | null = null;
  const api = {
    id: 'editor',
    title: 'Editor',
    isActive: false,
    isVisible: false,
    group: { id: 'g1', api: { isMaximized: () => false }, panels: [] },
    close: vi.fn(),
    setActive: vi.fn(),
    onDidActiveChange: (cb: (e: { isActive: boolean }) => void) => {
      activeCb = cb;
      return { dispose: vi.fn() };
    },
    onDidTitleChange: () => ({ dispose: vi.fn() }),
    onDidVisibilityChange: () => ({ dispose: () => {} }),
    onDidGroupChange: () => ({ dispose: vi.fn() }),
  };
  return { api, setActive: (v: boolean) => activeCb?.({ isActive: v }) };
}

describe('SharedTab · 标题节点在 active 切换中保持', () => {
  it('inactive → active → inactive,标题始终是同一个 DOM 节点且留在文档里', () => {
    const { api, setActive } = makeApi();
    const props = {
      api,
      containerApi: { onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }), exitMaximizedGroup: vi.fn() },
      params: {},
    } as unknown as Parameters<typeof SharedTab>[0];
    const { container } = render(<SharedTab {...props} />);
    const tab = container.querySelector('[role=tab]')!;
    const title = () => container.ownerDocument.getElementById(tab.getAttribute('aria-labelledby')!);
    const before = title();
    expect(before?.textContent).toBe('Editor');
    act(() => setActive(true));
    expect(title()).toBe(before);
    expect(before!.isConnected).toBe(true);
    act(() => setActive(false));
    expect(title()).toBe(before);
  });
});
