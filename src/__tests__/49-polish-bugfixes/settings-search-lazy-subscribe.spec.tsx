// @vitest-environment jsdom
// 打磨 R49(codex 性能):SettingsPanel 把搜索结果区拆成 SettingsSearchResults 子组件,
// 仅搜索模式(query 非空)时挂载。普通浏览设置 tab 时父组件不订阅 itemRegistry、
// 不构建搜索 haystack —— 插件注册 item / 切语言时不触发未使用的搜索派生。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup } from '@testing-library/react';
import { SettingsPanel } from '../../plugins/settings/SettingsPanel';
import { useSettingsStore } from '../../plugins/settings/store';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';
import { SettingItemRegistry } from '../../plugins/registries/SettingItemRegistry';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';

function tabReg(): SettingTabRegistry {
  const r = new SettingTabRegistry();
  r.register({ id: 'general', title: '通用', render: () => '通用内容', priority: 10 });
  return r;
}

beforeEach(() => {
  useSettingsStore.setState({ activeTabId: null });
  useSettingsValuesStore.setState({ values: {} });
});
afterEach(() => cleanup());

describe('打磨 R49 — 设置搜索懒订阅', () => {
  it('普通模式(空 query)→ 不订阅 itemRegistry', () => {
    const itemReg = new SettingItemRegistry();
    const subSpy = vi.spyOn(itemReg, 'subscribe');
    render(<SettingsPanel registry={tabReg()} itemRegistry={itemReg} />);
    expect(subSpy).not.toHaveBeenCalled();
    // 普通模式渲染 active tab 内容
    expect(document.body.textContent).toContain('通用内容');
  });

  it('输入 query → 挂载搜索区,开始订阅 itemRegistry', () => {
    const itemReg = new SettingItemRegistry();
    itemReg.register({
      id: 'general.theme',
      category: 'general',
      title: '主题',
      type: 'select',
      default: 'dark',
    });
    const subSpy = vi.spyOn(itemReg, 'subscribe');
    const { container } = render(
      <SettingsPanel registry={tabReg()} itemRegistry={itemReg} />,
    );
    expect(subSpy).not.toHaveBeenCalled();

    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '主题' } });
    expect(subSpy).toHaveBeenCalled();
    expect(container.textContent).toMatch(/匹配\s*1\s*项/);
  });
});
