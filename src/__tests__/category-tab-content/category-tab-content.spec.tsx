// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { CategoryTabContent } from '../../plugins/settings/CategoryTabContent';
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
});
