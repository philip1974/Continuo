// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import {
  CategoryTabContent,
  groupItems,
} from '../../plugins/settings/CategoryTabContent';
import {
  SettingItemRegistry,
  type SettingItemSpec,
} from '../../plugins/registries/SettingItemRegistry';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';

beforeEach(() => {
  useSettingsValuesStore.setState({ values: {} });
});

afterEach(() => cleanup());

function spec(over: Partial<SettingItemSpec>): SettingItemSpec {
  return {
    id: 'general.test',
    category: 'general',
    title: 'Test',
    type: 'boolean',
    default: false,
    ...over,
  };
}

describe('CategoryTabContent', () => {
  it('items 空 → 显示「本类暂无设置项」', () => {
    const reg = new SettingItemRegistry();
    const { container } = render(
      <CategoryTabContent category="general" registry={reg} />,
    );
    expect(container.textContent).toContain('本类暂无设置项');
  });

  it('多 spec 一组 default bucket → 无 h3 header,每项一行', () => {
    const reg = new SettingItemRegistry();
    reg.register(spec({ id: 'a', title: 'A', priority: 10 }));
    reg.register(spec({ id: 'b', title: 'B', priority: 20 }));
    const { container } = render(
      <CategoryTabContent category="general" registry={reg} />,
    );
    expect(container.querySelectorAll('h3').length).toBe(0);
    expect(container.textContent).toContain('A');
    expect(container.textContent).toContain('B');
  });

  it('spec.group → 渲染 group h3 header', () => {
    const reg = new SettingItemRegistry();
    reg.register(spec({ id: 'a', title: 'A', group: '外观' }));
    reg.register(spec({ id: 'b', title: 'B', group: '行为' }));
    const { container } = render(
      <CategoryTabContent category="general" registry={reg} />,
    );
    const headers = Array.from(container.querySelectorAll('h3')).map(
      (h) => h.textContent,
    );
    expect(headers).toEqual(['外观', '行为']);
  });

  it('groupItems 不通过 Array.from(entries).map 生成中间数组', () => {
    const itemA = spec({ id: 'a', title: 'A', group: '外观' });
    const itemB = spec({ id: 'b', title: 'B', group: '行为' });
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      const buckets = groupItems([itemA, itemB]);
      expect(arrayFromSpy).not.toHaveBeenCalled();
      expect(buckets.map((bucket) => bucket.group)).toEqual(['外观', '行为']);
      expect(buckets[0]?.items).toEqual([itemA]);
      expect(buckets[1]?.items).toEqual([itemB]);
      expect(groupItems.toString()).not.toContain('buckets.push(');
      expect(groupItems.toString()).not.toContain('.push(');
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  it('groupItems 空列表 → 稳定空 buckets,不创建 Map', () => {
    const getSpy = vi.spyOn(Map.prototype, 'get');

    try {
      expect(groupItems([])).toEqual([]);
      expect(groupItems([])).toBe(groupItems([]));
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('groupItems 单项列表不创建 Map 查找路径', () => {
    const item = spec({ id: 'a', title: 'A', group: '外观' });
    const getSpy = vi.spyOn(Map.prototype, 'get');

    try {
      const buckets = groupItems([item]);
      expect(getSpy).not.toHaveBeenCalled();
      expect(buckets).toEqual([
        { group: '外观', groupKey: undefined, items: [item] },
      ]);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('groupItems 多项全在同一组时复用输入 items,不创建 Map 查找路径', () => {
    const items = [
      spec({ id: 'a', title: 'A', group: '外观' }),
      spec({ id: 'b', title: 'B', group: '外观' }),
    ];
    const getSpy = vi.spyOn(Map.prototype, 'get');

    try {
      const buckets = groupItems(items);

      expect(getSpy).not.toHaveBeenCalled();
      expect(buckets).toEqual([
        { group: '外观', groupKey: undefined, items },
      ]);
      expect(buckets[0]?.items).toBe(items);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('default bucket + group bucket 共存,default 在前', () => {
    const reg = new SettingItemRegistry();
    reg.register(spec({ id: 'noGroup', title: 'NoGroup', priority: 10 }));
    reg.register(
      spec({ id: 'inGroup', title: 'InGroup', group: '高级', priority: 20 }),
    );
    const { container } = render(
      <CategoryTabContent category="general" registry={reg} />,
    );
    const sections = container.querySelectorAll('section');
    expect(sections.length).toBe(2);
    // 第一个 section 不应有 h3
    expect(sections[0]!.querySelector('h3')).toBeNull();
    expect(sections[1]!.querySelector('h3')!.textContent).toBe('高级');
  });

  it('其它 category 的 spec 不渲染', () => {
    const reg = new SettingItemRegistry();
    reg.register(spec({ id: 'a', category: 'editor', title: 'EditorA' }));
    const { container } = render(
      <CategoryTabContent category="general" registry={reg} />,
    );
    expect(container.textContent).toContain('本类暂无设置项');
    expect(container.textContent).not.toContain('EditorA');
  });

  it('动态注册新 item → 列表立即追加', () => {
    const reg = new SettingItemRegistry();
    const { container } = render(
      <CategoryTabContent category="general" registry={reg} />,
    );
    expect(container.textContent).toContain('本类暂无设置项');

    act(() => {
      reg.register(spec({ id: 'x', title: 'NewItem' }));
    });
    expect(container.textContent).toContain('NewItem');
  });

  it('category prop 切换 → 重读 items', () => {
    const reg = new SettingItemRegistry();
    reg.register(spec({ id: 'a', category: 'general', title: 'GenA' }));
    reg.register(spec({ id: 'b', category: 'editor', title: 'EdB' }));

    const { container, rerender } = render(
      <CategoryTabContent category="general" registry={reg} />,
    );
    expect(container.textContent).toContain('GenA');
    expect(container.textContent).not.toContain('EdB');

    rerender(<CategoryTabContent category="editor" registry={reg} />);
    expect(container.textContent).toContain('EdB');
    expect(container.textContent).not.toContain('GenA');
  });

  // 四个分类页共用本组件、只换 category prop:不得先提交一帧「导航已是新分类、内容还是旧分类的项」(此前 useRegistry 在
  // effect 里才 setSnap,中间帧 5–8ms,e2e 点「编辑器」后立刻取到通用页的 window.zoomLevel 输入框)。
  it('category prop 切换 → 同一次提交即渲染新分类的项(无旧分类内容的中间帧)', () => {
    const reg = new SettingItemRegistry();
    reg.register(spec({ id: 'a', category: 'general', title: 'GenA' }));
    reg.register(spec({ id: 'b', category: 'editor', title: 'EdB' }));
    const commits: string[] = [];
    function Probe({ category }: { readonly category: string }) {
      useLayoutEffect(() => {
        commits.push(`${category}:${document.body.textContent?.includes('GenA') ? 'GenA' : ''}${document.body.textContent?.includes('EdB') ? 'EdB' : ''}`);
      });
      return null;
    }
    const { rerender } = render(
      <>
        <CategoryTabContent category="general" registry={reg} />
        <Probe category="general" />
      </>,
    );
    commits.length = 0;
    rerender(
      <>
        <CategoryTabContent category="editor" registry={reg} />
        <Probe category="editor" />
      </>,
    );
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((c) => c === 'editor:EdB')).toBe(true);
  });
});
