// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { SharedTab } from '../../shell/motion/SharedTab';
import { setLocale, notifyLocaleChange } from '@/i18n';

interface FakeApi {
  id: string;
  title: string;
  isActive: boolean;
  group: {
    id: string;
    api: { isMaximized: () => boolean };
    panels?: ReadonlyArray<{ id: string; api: { setActive: () => void } }>;
  };
  close: ReturnType<typeof vi.fn>;
  setActive: ReturnType<typeof vi.fn>;
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
    // topic-22: SharedTab now reads api.group.api.isMaximized() initially
    group: { id: 'g1', api: { isMaximized: () => false } },
    close: vi.fn(),
    setActive: vi.fn(),
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
  // topic-22: containerApi 现在被订阅 onDidMaximizedGroupChange,需 mock
  const props = {
    api,
    containerApi: {
      onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }),
      exitMaximizedGroup: vi.fn(),
    } as never,
    params: {},
    onPointerDown: extra.onPointerDown,
    onPointerUp: extra.onPointerUp,
    onPointerLeave: extra.onPointerLeave,
  } as unknown as Parameters<typeof SharedTab>[0];
  return render(<SharedTab {...props} />);
}

describe('SharedTab — 渲染', () => {
  it('静态按钮图标预创建,避免每个 tab render 重复构造 svg', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/shell/motion/SharedTab.tsx'),
      'utf8',
    );

    expect(src).toContain('const EXIT_ZOOM_ICON = (');
    expect(src).toContain('const CLOSE_TAB_ICON = (');
    expect(src).toContain('{EXIT_ZOOM_ICON}');
    expect(src).toContain('{CLOSE_TAB_ICON}');
  });

  it('显示 title + close 按钮', () => {
    const api = makeApi({ title: 'Hello' });
    const { container } = renderTab(api);
    expect(container.textContent).toContain('Hello');
    // a11y(A105):关闭按钮 aria-label 本地化(默认测试 locale=zh → 「关闭 Hello」),含 title。
    expect(
      container.querySelector('button[aria-label="关闭 Hello"]'),
    ).not.toBeNull();
  });

  // a11y(A105):icon-only 关闭按钮可访问名随 locale 本地化(原硬编码英文 `Close ${title}`)。
  it('a11y · 关闭按钮 aria-label 随 locale 本地化', () => {
    setLocale('en');
    try {
      const api = makeApi({ title: 'Hello' });
      const { container } = renderTab(api);
      const btn = container.querySelector('button[aria-label*="Hello"]');
      expect(btn).not.toBeNull();
      expect(btn!.getAttribute('aria-label')).toBe('Close Hello');
    } finally {
      setLocale('zh');
    }
    cleanup();
    const api2 = makeApi({ title: 'Hello' });
    const { container: c2 } = renderTab(api2);
    const btn2 = c2.querySelector('button[aria-label*="Hello"]');
    expect(btn2!.getAttribute('aria-label')).toContain('关闭');
    expect(btn2!.getAttribute('aria-label')).not.toContain('Close');
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
      'button[aria-label^="关闭"]',
    ) as HTMLButtonElement;
    fireEvent.click(closeBtn);
    expect(api.close).toHaveBeenCalledTimes(1);
  });
});

describe('SharedTab — a11y(A119)tab 语义 + 键盘激活', () => {
  it('tab 根有 role=tab + aria-selected + roving tabIndex', () => {
    const active = makeApi({ isActive: true });
    const a = renderTab(active);
    const tabA = a.container.querySelector('[role=tab]') as HTMLElement;
    expect(tabA).not.toBeNull();
    expect(tabA.getAttribute('aria-selected')).toBe('true');
    expect(tabA.getAttribute('tabindex')).toBe('0'); // active 在 Tab 顺序
    cleanup();
    const inactive = makeApi({ isActive: false });
    const b = renderTab(inactive);
    const tabB = b.container.querySelector('[role=tab]') as HTMLElement;
    expect(tabB.getAttribute('aria-selected')).toBe('false');
    expect(tabB.getAttribute('tabindex')).toBe('-1'); // inactive 移出 Tab 顺序
  });

  it('Enter/Space → api.setActive()(键盘激活切 tab)', () => {
    const api = makeApi();
    const { container } = renderTab(api);
    const root = container.querySelector('[role=tab]') as HTMLElement;
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(api.setActive).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(root, { key: ' ' });
    expect(api.setActive).toHaveBeenCalledTimes(2);
  });

  // a11y(A120):完整 tablist 方向键模型 —— ArrowRight/Left 在同组 tab 间循环激活,Home/End 首尾。
  it('ArrowRight/Left/Home/End → 激活同组相邻/首尾 tab', () => {
    const next = { id: 'p-next', api: { setActive: vi.fn() } };
    const prev = { id: 'p-prev', api: { setActive: vi.fn() } };
    // panel 顺序:prev, self(p1), next → ArrowRight=next, ArrowLeft=prev, Home=prev, End=next。
    const api = makeApi();
    api.group.panels = [prev, { id: api.id, api: { setActive: api.setActive } }, next];
    const { container } = renderTab(api);
    const root = container.querySelector('[role=tab]') as HTMLElement;

    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(next.api.setActive).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(prev.api.setActive).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(root, { key: 'Home' });
    expect(prev.api.setActive).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(root, { key: 'End' });
    expect(next.api.setActive).toHaveBeenCalledTimes(2);
  });

  it('方向键定位当前 tab 时不调用 panels.findIndex', () => {
    const next = { id: 'p-next', api: { setActive: vi.fn() } };
    const panels = [
      { id: 'p-prev', api: { setActive: vi.fn() } },
      { id: 'p1', api: { setActive: vi.fn() } },
      next,
    ];
    const findIndexSpy = vi.spyOn(panels, 'findIndex');
    const api = makeApi();
    api.group.panels = panels;
    const { container } = renderTab(api);
    const root = container.querySelector('[role=tab]') as HTMLElement;

    try {
      fireEvent.keyDown(root, { key: 'ArrowRight' });

      expect(next.api.setActive).toHaveBeenCalledTimes(1);
      expect(findIndexSpy).not.toHaveBeenCalled();
    } finally {
      findIndexSpy.mockRestore();
    }
  });

  // a11y(A124,A123 后续):退出最大化按钮移出 Tab 顺序后,最大化态须有键盘等价入口(Escape)。
  it('最大化态 Escape → containerApi.exitMaximizedGroup()', () => {
    const api = makeApi();
    api.group.api.isMaximized = () => true; // 强制 maximized 初始态
    const exitMaximizedGroup = vi.fn();
    const props = {
      api,
      containerApi: {
        onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }),
        exitMaximizedGroup,
      } as never,
      params: {},
    } as unknown as Parameters<typeof SharedTab>[0];
    const { container } = render(<SharedTab {...props} />);
    const root = container.querySelector('[role=tab]') as HTMLElement;
    fireEvent.keyDown(root, { key: 'Escape' });
    expect(exitMaximizedGroup).toHaveBeenCalledTimes(1);
  });

  it('非最大化态 Escape → 不调 exitMaximizedGroup', () => {
    const api = makeApi(); // isMaximized() = false(默认)
    const exitMaximizedGroup = vi.fn();
    const props = {
      api,
      containerApi: {
        onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }),
        exitMaximizedGroup,
      } as never,
      params: {},
    } as unknown as Parameters<typeof SharedTab>[0];
    const { container } = render(<SharedTab {...props} />);
    const root = container.querySelector('[role=tab]') as HTMLElement;
    fireEvent.keyDown(root, { key: 'Escape' });
    expect(exitMaximizedGroup).not.toHaveBeenCalled();
  });

  // a11y(A123,A29 同族):tab 内关闭按钮移出 Tab 顺序(tabIndex=-1)保 roving;Delete/Backspace 关闭。
  it('关闭按钮 tabIndex=-1 + Delete/Backspace 关闭当前 tab', () => {
    const api = makeApi();
    const { container } = renderTab(api);
    const closeBtn = container.querySelector(
      'button[aria-label^="关闭"]',
    ) as HTMLButtonElement;
    expect(closeBtn.getAttribute('tabindex')).toBe('-1');
    const root = container.querySelector('[role=tab]') as HTMLElement;
    fireEvent.keyDown(root, { key: 'Delete' });
    expect(api.close).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(root, { key: 'Backspace' });
    expect(api.close).toHaveBeenCalledTimes(2);
  });

  it('单 tab(panels.length<=1)→ 方向键不激活(无相邻)', () => {
    const api = makeApi();
    api.group.panels = [{ id: api.id, api: { setActive: api.setActive } }];
    const { container } = renderTab(api);
    const root = container.querySelector('[role=tab]') as HTMLElement;
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(api.setActive).not.toHaveBeenCalled();
  });

  // a11y(A125,A121 后续):tablist aria-label 须随 locale 切换更新(useT 订阅 + 去「仅缺失时设」守卫)。
  it('locale 切换 → .dv-tabs-container aria-label 随之更新', () => {
    const api = makeApi();
    const stripContainer = document.createElement('div');
    stripContainer.className = 'dv-tabs-container';
    document.body.appendChild(stripContainer);
    try {
      const props = {
        api,
        containerApi: {
          onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }),
          exitMaximizedGroup: vi.fn(),
        } as never,
        params: {},
      } as unknown as Parameters<typeof SharedTab>[0];
      setLocale('en');
      render(<SharedTab {...props} />, { container: stripContainer });
      expect(stripContainer.getAttribute('aria-label')).toBe('Panel tabs');
      // 切到 zh → notifyLocaleChange 让 useT 重渲 → effect 重写 aria-label
      // (生产路径 settings.store.setLocale 会同时调 setI18nModuleLocale + notifyLocaleChange)。
      act(() => {
        setLocale('zh');
        notifyLocaleChange();
      });
      expect(stripContainer.getAttribute('aria-label')).toBe('面板标签');
    } finally {
      setLocale('zh');
      stripContainer.remove();
    }
  });

  // a11y(A121):role=tab 须有父 role=tablist;挂载时给 dockview .dv-tabs-container 补 tablist 语义。
  it('挂载 → 最近 .dv-tabs-container 补 role=tablist + aria-label', () => {
    const api = makeApi();
    // 模拟 dockview 的 tab-strip 容器作为渲染目标(SharedTab 是其后代)。
    const stripContainer = document.createElement('div');
    stripContainer.className = 'dv-tabs-container';
    document.body.appendChild(stripContainer);
    try {
      const props = {
        api,
        containerApi: {
          onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }),
          exitMaximizedGroup: vi.fn(),
        } as never,
        params: {},
      } as unknown as Parameters<typeof SharedTab>[0];
      render(<SharedTab {...props} />, { container: stripContainer });
      expect(stripContainer.getAttribute('role')).toBe('tablist');
      expect((stripContainer.getAttribute('aria-label') ?? '').length).toBeGreaterThan(
        0,
      );
    } finally {
      stripContainer.remove();
    }
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
