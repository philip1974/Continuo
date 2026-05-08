// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { SharedTab } from '../../shell/motion/SharedTab';

interface FakeApi {
  id: string;
  title: string;
  isActive: boolean;
  group: { id: string };
  close: ReturnType<typeof vi.fn>;
  onDidActiveChange: (cb: (e: { isActive: boolean }) => void) => {
    dispose: () => void;
  };
  onDidTitleChange: (cb: (e: { title: string }) => void) => {
    dispose: () => void;
  };
  __triggerActiveChange: (isActive: boolean) => void;
  __triggerTitleChange: (title: string) => void;
}

function makeApi(over: Partial<FakeApi> = {}): FakeApi {
  let activeCb: ((e: { isActive: boolean }) => void) | null = null;
  let titleCb: ((e: { title: string }) => void) | null = null;
  return {
    id: 'p1',
    title: 'Tab Title',
    isActive: false,
    group: { id: 'g1' },
    close: vi.fn(),
    onDidActiveChange: (cb) => {
      activeCb = cb;
      return { dispose: vi.fn() };
    },
    onDidTitleChange: (cb) => {
      titleCb = cb;
      return { dispose: vi.fn() };
    },
    __triggerActiveChange: (isActive) => activeCb?.({ isActive }),
    __triggerTitleChange: (title) => titleCb?.({ title }),
    ...over,
  };
}

afterEach(() => cleanup());

function renderTab(
  api: FakeApi,
  extra: {
    onPointerDown?: (e: never) => void;
    onPointerUp?: (e: never) => void;
    onPointerLeave?: (e: never) => void;
  } = {},
) {
  // SharedTab 类型签名要求 IDockviewPanelHeaderProps,这里用 unknown 桥
  const props = {
    api,
    containerApi: {} as never,
    params: {},
    onPointerDown: extra.onPointerDown,
    onPointerUp: extra.onPointerUp,
    onPointerLeave: extra.onPointerLeave,
  } as unknown as Parameters<typeof SharedTab>[0];
  return render(<SharedTab {...props} />);
}

describe('SharedTab — 渲染', () => {
  it('显示 title + close 按钮', () => {
    const api = makeApi({ title: 'Hello' });
    const { container } = renderTab(api);
    expect(container.textContent).toContain('Hello');
    expect(
      container.querySelector('button[aria-label="Close Hello"]'),
    ).not.toBeNull();
  });
});

describe('SharedTab — title 同步', () => {
  it('api.onDidTitleChange → 显示新 title', () => {
    const api = makeApi({ title: 'old' });
    const { container } = renderTab(api);
    expect(container.textContent).toContain('old');
    act(() => {
      api.__triggerTitleChange('new');
    });
    expect(container.textContent).toContain('new');
  });
});

describe('SharedTab — active 同步', () => {
  it('active=false → 普通 span;active=true → motion 指示条出现', () => {
    const api = makeApi({ title: 't' });
    const { container } = renderTab(api);
    // 没有 indicator(.bg-accent 在 inactive 时不渲染)
    expect(container.querySelector('.bg-accent')).toBeNull();

    act(() => {
      api.__triggerActiveChange(true);
    });
    // 现在 motion.span 指示条已挂载
    expect(container.querySelector('.bg-accent')).not.toBeNull();
  });
});

describe('SharedTab — close 按钮', () => {
  it('点击 → api.close() + preventDefault', () => {
    const api = makeApi();
    const { container } = renderTab(api);
    const closeBtn = container.querySelector(
      'button[aria-label^="Close"]',
    ) as HTMLButtonElement;
    fireEvent.click(closeBtn);
    expect(api.close).toHaveBeenCalledTimes(1);
  });
});

describe('SharedTab — 中键关闭', () => {
  it('button=1 down + up → api.close()', () => {
    const api = makeApi();
    const { container } = renderTab(api);
    const root = container.querySelector('.group\\/tab') as HTMLElement;

    fireEvent.pointerDown(root, { button: 1 });
    fireEvent.pointerUp(root, { button: 1 });
    expect(api.close).toHaveBeenCalledTimes(1);
  });

  it('button=0(左键)down/up → 不调 close', () => {
    const api = makeApi();
    const { container } = renderTab(api);
    const root = container.querySelector('.group\\/tab') as HTMLElement;
    fireEvent.pointerDown(root, { button: 0 });
    fireEvent.pointerUp(root, { button: 0 });
    expect(api.close).not.toHaveBeenCalled();
  });

  it('中键 down 后 pointerleave → 抬起不再触发 close', () => {
    const api = makeApi();
    const { container } = renderTab(api);
    const root = container.querySelector('.group\\/tab') as HTMLElement;
    fireEvent.pointerDown(root, { button: 1 });
    fireEvent.pointerLeave(root);
    fireEvent.pointerUp(root, { button: 1 });
    expect(api.close).not.toHaveBeenCalled();
  });
});

describe('SharedTab — 透传 dockview pointer handler', () => {
  it('onPointerDown / onPointerUp / onPointerLeave 都被调', () => {
    const api = makeApi();
    const onPointerDown = vi.fn();
    const onPointerUp = vi.fn();
    const onPointerLeave = vi.fn();
    const { container } = renderTab(api, {
      onPointerDown,
      onPointerUp,
      onPointerLeave,
    });
    const root = container.querySelector('.group\\/tab') as HTMLElement;
    fireEvent.pointerDown(root, { button: 0 });
    fireEvent.pointerUp(root, { button: 0 });
    fireEvent.pointerLeave(root);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerUp).toHaveBeenCalledTimes(1);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
  });
});
