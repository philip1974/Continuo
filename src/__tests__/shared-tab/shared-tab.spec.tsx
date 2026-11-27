// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { DockviewComponent } from 'dockview-react';
import { SharedTab } from '../../shell/motion/SharedTab';
import { setLocale, notifyLocaleChange } from '@/i18n';
import {
  __resetTerminalPanelHandlesForTest,
  registerTerminalPanelHandles,
} from '@/panels/Terminal/terminal-panel-handles';

interface FakeApi {
  id: string;
  title: string;
  isActive: boolean;
  /** 本组正显示(dockview api.isVisible);缺省同 isActive */
  isVisible?: boolean;
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
  onDidVisibilityChange: (cb: (e: { isVisible: boolean }) => void) => {
    dispose: () => void;
  };
  onDidGroupChange: (cb: () => void) => { dispose: () => void };
  __triggerActiveChange: (isActive: boolean) => void;
  __triggerVisibilityChange: (isVisible: boolean) => void;
  __triggerTitleChange: (title: string) => void;
}

function makeApi(over: Partial<FakeApi> = {}): FakeApi {
  let activeCb: ((e: { isActive: boolean }) => void) | null = null;
  let titleCb: ((e: { title: string }) => void) | null = null;
  let visibilityCb: ((e: { isVisible: boolean }) => void) | null = null;
  const api: FakeApi = {
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
    onDidVisibilityChange: (cb) => {
      visibilityCb = cb;
      return { dispose: vi.fn() };
    },
    onDidGroupChange: () => ({ dispose: vi.fn() }),
    __triggerActiveChange: (isActive) => activeCb?.({ isActive }),
    __triggerTitleChange: (title) => titleCb?.({ title }),
    __triggerVisibilityChange: (isVisible) => visibilityCb?.({ isVisible }),
    ...over,
  };
  api.isVisible ??= api.isActive;
  return api;
}

afterEach(() => cleanup());

function renderTab(api: FakeApi) {
  // SharedTab 类型签名要求 IDockviewPanelHeaderProps,这里用 unknown 桥
  // topic-22: containerApi 现在被订阅 onDidMaximizedGroupChange,需 mock
  const props = {
    api,
    containerApi: {
      onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }),
      exitMaximizedGroup: vi.fn(),
    } as never,
    params: {},
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
      container.querySelector('[role=button][aria-label="关闭 Hello"]'),
    ).not.toBeNull();
  });

  // a11y:role=tab 的可访问名称只是标题(对齐 VSCode tab / WAI-ARIA tabs),不把内嵌关闭 / 退出最大化按钮的名称拼进来
  //(修复前 Chromium 按内容计算名称,读屏念「编辑器 关闭 编辑器」)。tab 以 aria-labelledby 只引用标题元素;
  // active(motion span)/ inactive / 标题变化都成立。(jsdom 的 dom-accessibility-api 不把内嵌按钮计入,
  // 故按引用关系断言;真实 Chromium 名称见 e2e tab-accessible-name。)
  it('a11y · tab 可访问名称 = 标题(aria-labelledby 只指向标题),不含关闭按钮名称', () => {
    const labelOf = (container: HTMLElement): string => {
      const tab = container.querySelector('[role="tab"]')!;
      const ids = (tab.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
      expect(ids.length).toBe(1);
      const el = container.ownerDocument.getElementById(ids[0]!);
      expect(el).not.toBeNull();
      expect(tab.contains(el)).toBe(true);
      expect(el!.querySelector('button')).toBeNull();
      return el!.textContent ?? '';
    };
    const inactive = renderTab(makeApi({ title: 'Hello' }));
    expect(labelOf(inactive.container)).toBe('Hello');
    cleanup();
    const api = makeApi({ id: 'p2', title: '编辑器', isActive: true });
    const active = renderTab(api);
    expect(labelOf(active.container)).toBe('编辑器');
    act(() => api.__triggerTitleChange('终端'));
    expect(labelOf(active.container)).toBe('终端');
    act(() => api.__triggerActiveChange(false));
    expect(labelOf(active.container)).toBe('终端');
  });

  // a11y(A105):icon-only 关闭按钮可访问名随 locale 本地化(原硬编码英文 `Close ${title}`)。
  it('a11y · 关闭按钮 aria-label 随 locale 本地化', () => {
    setLocale('en');
    try {
      const api = makeApi({ title: 'Hello' });
      const { container } = renderTab(api);
      const btn = container.querySelector('[role=button][aria-label*="Hello"]');
      expect(btn).not.toBeNull();
      expect(btn!.getAttribute('aria-label')).toBe('Close Hello');
    } finally {
      setLocale('zh');
    }
    cleanup();
    const api2 = makeApi({ title: 'Hello' });
    const { container: c2 } = renderTab(api2);
    const btn2 = c2.querySelector('[role=button][aria-label*="Hello"]');
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
    // 现在 m.span 指示条已挂载
    expect(container.querySelector('.bg-accent')).not.toBeNull();
  });
});

// VSCode:每个编辑器组正显示的 tab 都 aria-selected=true、在 Tab 顺序里;只有全局活动组的活动 tab 带顶部强调条。
describe('SharedTab — 选中态按「本组正显示」(非活动组的可见 tab 也选中)', () => {
  it('非活动组里正显示的 tab(isActive=false、isVisible=true)→ aria-selected=true、tabIndex=0,但没有强调条', () => {
    const api = makeApi({ isActive: false, isVisible: true });
    const { container } = renderTab(api);
    const tab = container.querySelector('[role=tab]') as HTMLElement;
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.getAttribute('tabindex')).toBe('0');
    expect(container.querySelector('.bg-accent')).toBeNull();
  });

  it('本组里被别的 tab 遮住(isVisible 变 false)→ aria-selected=false、移出 Tab 顺序;再显示 → 恢复', () => {
    const api = makeApi({ isActive: false, isVisible: true });
    const { container } = renderTab(api);
    const tab = container.querySelector('[role=tab]') as HTMLElement;
    act(() => api.__triggerVisibilityChange(false));
    expect(tab.getAttribute('aria-selected')).toBe('false');
    expect(tab.getAttribute('tabindex')).toBe('-1');
    act(() => api.__triggerVisibilityChange(true));
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.getAttribute('tabindex')).toBe('0');
  });

  it('dockview 语义:两组各自的活动面板 isVisible=true,只有活动组的 isActive=true;组内被遮住的面板 isVisible=false', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const dock = new DockviewComponent(container, {
      createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
    });
    const a = dock.api.addPanel({ id: 'a', component: 'x', title: 'a' });
    const hidden = dock.api.addPanel({ id: 'hidden', component: 'x', title: 'hidden', position: { referencePanel: 'a' } });
    a.api.setActive();
    const b = dock.api.addPanel({ id: 'b', component: 'x', title: 'b', position: { referencePanel: 'a', direction: 'right' } });
    b.api.setActive();
    expect(b.api.isActive).toBe(true);
    expect(a.api.isActive).toBe(false);
    expect(a.api.isVisible).toBe(true);
    expect(hidden.api.isVisible).toBe(false);
    dock.dispose();
    vi.unstubAllGlobals();
  });
});

describe('SharedTab — close 按钮', () => {
  it('点击 → api.close() + preventDefault', () => {
    const api = makeApi();
    const { container } = renderTab(api);
    const closeBtn = container.querySelector(
      '[role=button][aria-label^="关闭"]',
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

  // a11y(A123,A29 同族;axe nested-interactive):tab 的子元素是 presentational,不能有可聚焦控件 —— 关闭 / 退出缩放
  // 是不可聚焦的 role=button(鼠标点击);键盘关闭只认 tab 上的 Delete,退出缩放走 Escape / ⇧⌘Enter。
  it('tab 内无可聚焦子元素;关闭按钮不可聚焦 + Delete 关闭当前 tab', () => {
    const api = makeApi();
    api.group.api.isMaximized = () => true;
    const { container } = renderTab(api);
    const root0 = container.querySelector('[role=tab]') as HTMLElement;
    expect(root0.querySelectorAll('button, input, a[href], [tabindex]')).toHaveLength(0);
    const closeBtn = container.querySelector(
      '[role=button][aria-label^="关闭"]',
    ) as HTMLElement;
    expect(closeBtn.hasAttribute('tabindex')).toBe(false);
    expect(container.querySelector('[data-testid="tab-maximize-indicator"]')!.getAttribute('role')).toBe('button');
    const root = container.querySelector('[role=tab]') as HTMLElement;
    fireEvent.keyDown(root, { key: 'Delete' });
    expect(api.close).toHaveBeenCalledTimes(1);
  });

  // 焦点停在 tab 上时用户以为在终端里打字,退格不得关闭 tab(终端 tab 关闭 = 杀 PTY)。
  // VSCode 的 tab 上同样没有退格关闭。
  it('Backspace 不关闭 tab', () => {
    const api = makeApi();
    const { container } = renderTab(api);
    const root = container.querySelector('[role=tab]') as HTMLElement;
    fireEvent.keyDown(root, { key: 'Backspace' });
    expect(api.close).not.toHaveBeenCalled();
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

describe('SharedTab — 鼠标点击后焦点回到面板内容(VSCode:点 tab = 聚焦该编辑器)', () => {
  afterEach(() => {
    __resetTerminalPanelHandlesForTest();
    document.body.innerHTML = '';
  });

  function withContent(api: FakeApi, content: HTMLElement): void {
    document.body.appendChild(content);
    (api.group as { panels?: unknown }).panels = [
      { id: api.id, api: { setActive: api.setActive }, view: { content: { element: content } } },
    ];
  }

  it('终端面板:鼠标点 tab → 调该面板注册的 focus 句柄', () => {
    const api = makeApi({ isActive: true });
    const focus = vi.fn();
    registerTerminalPanelHandles(api.id, { focus, openSearch: vi.fn(), clear: vi.fn(), readText: vi.fn(() => "") });
    const { container } = renderTab(api);
    const root = container.querySelector('[role=tab]') as HTMLElement;
    fireEvent.click(root, { detail: 1 });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('其它面板:鼠标点 tab → 优先聚焦内容里的可编辑元素', () => {
    const api = makeApi({ isActive: true });
    const content = document.createElement('div');
    content.innerHTML =
      '<button>header</button><div class="cm-content" contenteditable="true" tabindex="0"></div>';
    withContent(api, content);
    const { container } = renderTab(api);
    const root = container.querySelector('[role=tab]') as HTMLElement;
    root.focus();
    fireEvent.click(root, { detail: 1 });
    expect(document.activeElement).toBe(content.querySelector('.cm-content'));
  });

  it('其它面板无可编辑元素 → 聚焦第一个可 Tab 到的控件', () => {
    const api = makeApi({ isActive: true });
    const content = document.createElement('div');
    content.innerHTML = '<span>text</span><button>first</button><button>second</button>';
    withContent(api, content);
    const { container } = renderTab(api);
    const root = container.querySelector('[role=tab]') as HTMLElement;
    fireEvent.click(root, { detail: 1 });
    expect(document.activeElement?.textContent).toBe('first');
  });

  it('键盘触发的 click(detail=0)不移走焦点(tablist 键盘模型保持)', () => {
    const api = makeApi({ isActive: true });
    const focus = vi.fn();
    registerTerminalPanelHandles(api.id, { focus, openSearch: vi.fn(), clear: vi.fn(), readText: vi.fn(() => "") });
    const { container } = renderTab(api);
    const root = container.querySelector('[role=tab]') as HTMLElement;
    fireEvent.click(root, { detail: 0 });
    expect(focus).not.toHaveBeenCalled();
  });

  it('点关闭按钮不触发聚焦面板', () => {
    const api = makeApi({ isActive: true });
    const focus = vi.fn();
    registerTerminalPanelHandles(api.id, { focus, openSearch: vi.fn(), clear: vi.fn(), readText: vi.fn(() => "") });
    const { container } = renderTab(api);
    const closeBtn = container.querySelector('[role=button][aria-label^="关闭"]') as HTMLElement;
    fireEvent.click(closeBtn, { detail: 1 });
    expect(focus).not.toHaveBeenCalled();
  });

  it('关闭 / 退出缩放图标按钮有 title 悬停提示(与可访问名一致)', () => {
    const api = makeApi({ title: 'Hello' });
    api.group.api.isMaximized = () => true;
    const { container } = renderTab(api);
    const closeBtn = container.querySelector('[role=button][aria-label="关闭 Hello"]') as HTMLElement;
    expect(closeBtn.getAttribute('title')).toBe('关闭 Hello');
    const zoomBtn = container.querySelector('[data-testid="tab-maximize-indicator"]') as HTMLButtonElement;
    expect(zoomBtn.getAttribute('title')).toBe(zoomBtn.getAttribute('aria-label'));
    expect(zoomBtn.getAttribute('title')).toBeTruthy();
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
