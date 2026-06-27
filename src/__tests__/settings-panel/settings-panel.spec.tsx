// @vitest-environment jsdom
// BDD: settings-panel
// 测 SettingsPanel UI 行为(左导航 + 右内容 + 空态 + 动态注册);
// store API(activeTabId / setActiveTabId,无 isOpen / open / close)。
//
// 此 spec 在实装前会 red:
//   src/plugins/settings/SettingsPanel.tsx 不存在
//   store.ts 旧 isOpen / open / close API 已被移除

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import {
  SettingsPanel,
  buildSearchableSettingItems,
  buildSettingSearchHaystack,
  groupSearchResults,
  settingsNavClassName,
  settingsTabButtonClassName,
  selectMatchedSettingItems,
} from '../../plugins/settings/SettingsPanel';
import { useSettingsStore } from '../../plugins/settings/store';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';
import { SettingItemRegistry } from '../../plugins/registries/SettingItemRegistry';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';

beforeEach(() => {
  useSettingsStore.setState({ activeTabId: null });
});
afterEach(() => cleanup());

function makeReg(): SettingTabRegistry {
  const r = new SettingTabRegistry();
  r.register({ id: 'general', title: '通用', render: () => '通用内容', priority: 10 });
  r.register({ id: 'editor', title: '编辑器', render: () => '编辑器内容', priority: 20 });
  r.register({ id: 'plugins', title: '插件', render: () => '插件内容', priority: 30 });
  return r;
}

// ────────────────────────────────────────────────────────────
// 渲染:有 tab 时
// ────────────────────────────────────────────────────────────

describe('SettingsPanel · 基础渲染', () => {
  it('渲染所有 tab + 默认选首项(priority 升序)', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    const navBtns = container.querySelectorAll('nav button');
    expect(navBtns.length).toBe(3);
    expect(navBtns[0]?.textContent).toBe('通用');
    expect(container.textContent).toContain('通用内容');
  });

  // a11y(A5,A1 同族):设置面板搜索框须有 aria-label 可访问名(屏幕阅读器)。
  it('a11y · 搜索 Input 有 aria-label 可访问名', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    const input = container.querySelector('input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const ariaLabel = input!.getAttribute('aria-label') ?? '';
    expect(ariaLabel.length).toBeGreaterThan(0);
    expect(ariaLabel).toBe(input!.getAttribute('placeholder'));
  });

  it('点击 tab → 切换右侧内容 + 写 store.activeTabId', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    const navBtns = container.querySelectorAll('nav button');
    fireEvent.click(navBtns[1]!);
    expect(container.textContent).toContain('编辑器内容');
    expect(useSettingsStore.getState().activeTabId).toBe('editor');
  });

  // a11y(A11):tab 导航 active 项须用 aria-current=page 暴露选中态(原只用 className)。
  it('a11y · 当前 tab 有 aria-current=page,其余无', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    const navBtns = Array.from(container.querySelectorAll('nav button'));
    // 默认选首项(通用)
    expect(navBtns[0]!.getAttribute('aria-current')).toBe('page');
    expect(navBtns[1]!.getAttribute('aria-current')).toBeNull();
    // 切到第二项 → aria-current 跟随
    fireEvent.click(navBtns[1]!);
    const after = Array.from(container.querySelectorAll('nav button'));
    expect(after[1]!.getAttribute('aria-current')).toBe('page');
    expect(after[0]!.getAttribute('aria-current')).toBeNull();
  });

  // a11y(A17,A12 同族):搜索模式下左侧 nav 仅 pointer-events-none(鼠标禁用)但键盘仍可
  // Tab/Enter → nav 按钮须 disabled,与视觉禁用一致。
  it('a11y · 搜索模式下 nav 按钮 disabled(键盘也不可触发)', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    const navBtns = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('nav button'));
    expect(navBtns().every((b) => !b.disabled)).toBe(true); // 非搜索:可用
    // 输入搜索 → inSearch=true
    const searchInput = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'theme' } });
    expect(navBtns().length).toBeGreaterThan(0);
    expect(navBtns().every((b) => b.disabled)).toBe(true); // 搜索:全 disabled
  });

  it('store 预置 activeTabId → 渲染时直接选中该 tab', () => {
    useSettingsStore.setState({ activeTabId: 'plugins' });
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    expect(container.textContent).toContain('插件内容');
  });

  it('activeTabId 指向已 unregister 的 id → 兜底首项', () => {
    useSettingsStore.setState({ activeTabId: 'no-such-tab' });
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    expect(container.textContent).toContain('通用内容');
  });

  it('nav 和 tab className 不通过数组 join 重建', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join');

    try {
      expect(settingsNavClassName(false)).toContain('opacity-100');
      expect(settingsNavClassName(true)).toContain(
        'pointer-events-none opacity-40',
      );
      expect(settingsTabButtonClassName(true)).toContain(
        'border-accent bg-hover text-fg',
      );
      expect(settingsTabButtonClassName(false)).toContain(
        'border-transparent text-fg-muted hover:bg-hover/50',
      );
      expect(joinSpy).not.toHaveBeenCalled();
    } finally {
      joinSpy.mockRestore();
    }
  });
});

// ────────────────────────────────────────────────────────────
// 空态
// ────────────────────────────────────────────────────────────

describe('SettingsPanel · 空态', () => {
  it('无 tab 注册 → 显示"暂无设置项"', () => {
    const { container } = render(<SettingsPanel registry={new SettingTabRegistry()} />);
    expect(container.textContent).toContain('暂无设置项');
  });
});

// ────────────────────────────────────────────────────────────
// 动态 register / unregister
// ────────────────────────────────────────────────────────────

describe('SettingsPanel · 动态 registry', () => {
  it('运行时 register 新 tab → 列表自动更新', () => {
    const reg = new SettingTabRegistry();
    const { container } = render(<SettingsPanel registry={reg} />);
    expect(container.querySelectorAll('nav button').length).toBe(0);
    act(() => {
      reg.register({
        id: 'late',
        title: '晚到',
        render: () => '内容',
      });
    });
    expect(container.querySelectorAll('nav button').length).toBe(1);
  });

  it('运行时 dispose 当前 active tab 的 disposable → 兜底首项', () => {
    const reg = new SettingTabRegistry();
    reg.register({ id: 'general', title: '通用', render: () => '通用内容', priority: 10 });
    const editorD = reg.register({
      id: 'editor',
      title: '编辑器',
      render: () => '编辑器内容',
      priority: 20,
    });
    useSettingsStore.setState({ activeTabId: 'editor' });
    const { container } = render(<SettingsPanel registry={reg} />);
    expect(container.textContent).toContain('编辑器内容');
    act(() => editorD.dispose());
    expect(container.textContent).toContain('通用内容');
  });
});

// ────────────────────────────────────────────────────────────
// store API 形态(决策 #2:关 panel 不 reset)
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// 搜索模式
// ────────────────────────────────────────────────────────────

describe('SettingsPanel · 搜索模式', () => {
  function makeItemReg(): SettingItemRegistry {
    const r = new SettingItemRegistry();
    r.register({
      id: 'general.theme',
      category: 'general',
      title: '主题',
      description: 'Light / Dark',
      type: 'select',
      default: 'dark',
      enum: [
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' },
      ],
    });
    r.register({
      id: 'editor.fontSize',
      category: 'editor',
      title: '字号',
      description: '编辑器字体大小',
      type: 'number',
      default: 14,
    });
    r.register({
      id: 'plugins.foo.bar',
      category: 'pluginland',
      title: 'Plugin Bar',
      type: 'boolean',
      default: false,
    });
    return r;
  }

  beforeEach(() => {
    useSettingsValuesStore.setState({ values: {} });
  });

  it('搜索匹配单次遍历 searchable,不先 filter 再 map', () => {
    const itemA = {
      id: 'general.theme',
      category: 'general',
      title: '主题',
      type: 'boolean',
      default: false,
    } as const;
    const itemB = {
      id: 'editor.fontSize',
      category: 'editor',
      title: '字号',
      type: 'number',
      default: 14,
    } as const;
    const searchable = [
      { item: itemA, haystack: 'general theme' },
      { item: itemB, haystack: 'editor font size' },
    ] as const;
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      const matched = selectMatchedSettingItems(searchable, 'theme');
      const filterCallsOnSearchable = filterSpy.mock.contexts.filter(
        (ctx) => ctx === searchable,
      ).length;

      expect(filterCallsOnSearchable).toBe(0);
      expect(matched).toEqual([itemA]);
      expect(selectMatchedSettingItems.toString()).not.toContain('matched.push(');
    } finally {
      filterSpy.mockRestore();
    }
  });

  it('搜索 haystack 列表构造预分配数组,不调用 items.map', () => {
    const items = [
      {
        id: 'general.theme',
        category: 'general',
        title: '主题',
        description: 'Light / Dark',
        type: 'boolean',
        default: false,
      },
      {
        id: 'editor.fontSize',
        category: 'editor',
        title: '字号',
        type: 'number',
        default: 14,
      },
    ] as const;
    const mapSpy = vi.spyOn(items, 'map');

    try {
      const searchable = buildSearchableSettingItems(items);
      expect(searchable.map((entry) => entry.item.id)).toEqual([
        'general.theme',
        'editor.fontSize',
      ]);
      expect(searchable[0]?.haystack).toContain('light / dark');
      expect(mapSpy).not.toHaveBeenCalled();
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('搜索结果分组不通过 Array.from(entries).map 生成中间数组', () => {
    const itemA = {
      id: 'general.theme',
      category: 'general',
      title: '主题',
      type: 'boolean',
      default: false,
    } as const;
    const itemB = {
      id: 'editor.fontSize',
      category: 'editor',
      title: '字号',
      type: 'number',
      default: 14,
    } as const;
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      const buckets = groupSearchResults([itemA, itemB]);
      expect(arrayFromSpy).not.toHaveBeenCalled();
      expect(buckets.map((bucket) => bucket.category)).toEqual([
        'general',
        'editor',
      ]);
      expect(buckets[0]?.items).toEqual([itemA]);
      expect(buckets[1]?.items).toEqual([itemB]);
      expect(groupSearchResults.toString()).not.toContain('buckets.push(');
      expect(groupSearchResults.toString()).not.toContain('.push(');
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  it('单个搜索结果分组走快路径,不构造 Map', () => {
    const item = {
      id: 'editor.fontSize',
      category: 'editor',
      title: '字号',
      type: 'number',
      default: 14,
    } as const;
    const mapGetSpy = vi.spyOn(Map.prototype, 'get');

    try {
      const buckets = groupSearchResults([item]);
      expect(buckets).toHaveLength(1);
      expect(buckets[0]?.category).toBe('editor');
      expect(buckets[0]?.items).toEqual([item]);
      expect(mapGetSpy).not.toHaveBeenCalled();
    } finally {
      mapGetSpy.mockRestore();
    }
  });

  it('搜索 haystack 包含本地化字段/id/raw fallback,且不通过数组 join 拼接', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join');
    try {
      const haystack = buildSettingSearchHaystack({
        id: 'editor.fontSize',
        category: 'editor',
        title: 'Font Size Raw',
        description: 'Raw Description',
        type: 'number',
        default: 14,
      });

      expect(joinSpy).not.toHaveBeenCalled();
      expect(haystack).toContain('font size raw');
      expect(haystack).toContain('raw description');
      expect(haystack).toContain('editor.fontsize');
    } finally {
      joinSpy.mockRestore();
    }
  });

  it('搜索框输入 → 左 nav 半透明 + 右侧渲染搜索结果', () => {
    const { container } = render(
      <SettingsPanel registry={makeReg()} itemRegistry={makeItemReg()} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '主题' } });
    expect(container.textContent).toMatch(/匹配\s*1\s*项/);
    expect(container.querySelector('nav')!.className).toContain('opacity-40');
    // a11y(A54):搜索结果摘要须在 live region(role=status)播报匹配数量/无结果。
    const status = container.querySelector('[role=status]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toMatch(/匹配/);
  });

  it('match 命中 title / description / id', () => {
    const { container } = render(
      <SettingsPanel registry={makeReg()} itemRegistry={makeItemReg()} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '编辑器字体' } });
    expect(container.textContent).toContain('字号');

    fireEvent.change(input, { target: { value: 'plugins.foo' } });
    expect(container.textContent).toContain('Plugin Bar');
  });

  it('无匹配 → 「未找到匹配」', () => {
    const { container } = render(
      <SettingsPanel registry={makeReg()} itemRegistry={makeItemReg()} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'zzz_no_match' } });
    expect(container.textContent).toContain('未找到匹配');
  });

  it('搜索结果按 category 分桶,内置 category 有中文 label,自定义 fallback raw', () => {
    const { container } = render(
      <SettingsPanel registry={makeReg()} itemRegistry={makeItemReg()} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    // 搜 全部 → general/editor/pluginland 三个 bucket
    fireEvent.change(input, { target: { value: '' } });
    // 空 query 应离开搜索模式
    expect(container.textContent).not.toContain('匹配');

    // 搜 a 命中所有(包含 description / title)
    fireEvent.change(input, { target: { value: 'a' } });
    const headers = Array.from(container.querySelectorAll('h3')).map(
      (h) => h.textContent,
    );
    // pluginland 是自定义 category,fallback raw 显示
    expect(headers).toContain('pluginland');
    // 内置 category 应显示中文 label
    if (container.textContent!.includes('字号')) {
      expect(headers).toContain('编辑器');
    }
  });

  it('清空搜索 → 回普通模式,左 nav 不再半透明', () => {
    const { container } = render(
      <SettingsPanel registry={makeReg()} itemRegistry={makeItemReg()} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '主题' } });
    expect(container.querySelector('nav')!.className).toContain('opacity-40');

    fireEvent.change(input, { target: { value: '' } });
    expect(container.querySelector('nav')!.className).not.toContain(
      'opacity-40',
    );
  });

  it('全空白 query 视为非搜索模式', () => {
    const { container } = render(
      <SettingsPanel registry={makeReg()} itemRegistry={makeItemReg()} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    expect(container.textContent).not.toContain('匹配');
    expect(container.textContent).not.toContain('未找到');
  });
});

describe('useSettingsStore · API 形态', () => {
  it('只有 activeTabId / setActiveTabId,无 isOpen/open/close', () => {
    const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
    expect('activeTabId' in state).toBe(true);
    expect('setActiveTabId' in state).toBe(true);
    expect('isOpen' in state).toBe(false);
    expect('open' in state).toBe(false);
    expect('close' in state).toBe(false);
  });

  it('setActiveTabId 写入状态', () => {
    useSettingsStore.getState().setActiveTabId('foo');
    expect(useSettingsStore.getState().activeTabId).toBe('foo');
  });

  it('setActiveTabId 写入相同 id 时不通知订阅者', () => {
    useSettingsStore.setState({ activeTabId: 'foo' });
    const listener = vi.fn();
    const unsubscribe = useSettingsStore.subscribe(listener);

    try {
      useSettingsStore.getState().setActiveTabId('foo');

      expect(useSettingsStore.getState().activeTabId).toBe('foo');
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('panel unmount 后 activeTabId 仍保留(决策 #2)', () => {
    const reg = makeReg();
    const { container, unmount } = render(<SettingsPanel registry={reg} />);
    fireEvent.click(container.querySelectorAll('nav button')[2]!); // plugins
    expect(useSettingsStore.getState().activeTabId).toBe('plugins');
    unmount();
    // store 不变 — 重新打开还在 plugins
    expect(useSettingsStore.getState().activeTabId).toBe('plugins');
  });
});
