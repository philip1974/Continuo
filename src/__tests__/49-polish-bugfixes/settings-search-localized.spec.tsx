// @vitest-environment jsdom
// 打磨 R30(codex 一致性/i18n):SettingsPanel 搜索 haystack 用 titleKey/descriptionKey
// 翻译后的可见文案(SettingItemRow 实际显示的),否则中文/韩文下按屏幕文字搜不到。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, cleanup } from '@testing-library/react';
import { SettingsPanel } from '../../plugins/settings/SettingsPanel';
import { useSettingsStore } from '../../plugins/settings/store';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';
import { SettingItemRegistry } from '../../plugins/registries/SettingItemRegistry';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { setLocale } from '../../i18n';

function tabReg(): SettingTabRegistry {
  const r = new SettingTabRegistry();
  r.register({ id: 'terminal', title: '终端', render: () => 'x', priority: 10 });
  return r;
}

function itemReg(): SettingItemRegistry {
  const r = new SettingItemRegistry();
  // raw title 故意与 zh 翻译('字号')不同;titleKey 指向真实 catalog key。
  r.register({
    id: 'terminal.fontSize',
    category: 'terminal',
    title: 'ZZZ_RAW_TITLE',
    titleKey: 'settings.terminal.font_size',
    type: 'number',
    default: 14,
  });
  return r;
}

beforeEach(() => {
  useSettingsStore.setState({ activeTabId: null });
  useSettingsValuesStore.setState({ values: {} });
});
afterEach(() => {
  setLocale('en');
  cleanup();
});

describe('打磨 R30 — 设置搜索匹配本地化文案', () => {
  it('zh locale 下按可见中文「字号」能搜到(haystack 用 titleKey 翻译)', () => {
    setLocale('zh');
    const { container } = render(
      <SettingsPanel registry={tabReg()} itemRegistry={itemReg()} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '字号' } });
    expect(container.textContent).toMatch(/匹配\s*1\s*项/);
  });

  it('raw fallback 仍可搜(保留 id + raw title 作补充)', () => {
    setLocale('zh');
    const { container } = render(
      <SettingsPanel registry={tabReg()} itemRegistry={itemReg()} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'terminal.fontSize' } });
    expect(container.textContent).toMatch(/匹配\s*1\s*项/);
  });
});
