// @vitest-environment jsdom
// perf:设置首开不再两级 chunk 瀑布。此前 SettingsPanel 外壳 chunk 加载、渲染后,默认分类 tab 才开始拉
// CategoryTabContent chunk(串行两次往返)。现在 SettingsPanel 的 lazy 工厂同时发起 CategoryTabContent 的
// import —— 复用 lazy-category-tab 的同一 loader(同一模块实例);分类内容预取失败不影响设置外壳加载。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const h = vi.hoisted(() => ({
  loadCategoryTabContent: vi.fn(() => new Promise<never>(() => {})),
  shellImported: vi.fn(),
}));

vi.mock('@/core-plugins/lazy-category-tab', () => ({
  loadCategoryTabContent: h.loadCategoryTabContent,
  renderCategoryTab: () => null,
}));
vi.mock('@/plugins/settings/SettingsPanel', () => {
  h.shellImported();
  return { SettingsPanel: () => createElement('div', { 'data-testid': 'settings-shell' }) };
});

// 插件市场 / 插件 / 快捷键三个页签内容 chunk(各自独立 lazy)。注:vi.resetModules 不重置 mock 注册表,
// 工厂只在首次 import 时执行,故不在工厂里计数;判别依据是「外壳加载后页签 render() 同步出内容」。
vi.mock('@/marketplace/MarketplaceTab', () => ({ MarketplaceTab: () => createElement('div', { 'data-testid': 'tab-marketplace' }) }));
vi.mock('@/plugins/settings/PluginsTabContent', () => ({ PluginsTabContent: () => createElement('div', { 'data-testid': 'tab-plugins' }) }));
vi.mock('@/plugins/settings/KeybindingsTabContent', () => ({ KeybindingsTabContent: () => createElement('div', { 'data-testid': 'tab-keybindings' }) }));

// React.lazy 在模块级缓存首次加载结果:每个用例 resetModules 后重新 import,保证 lazy 工厂重新执行。
let shutdown: (() => Promise<void>) | null = null;
async function bootSettingsSpec() {
  vi.resetModules();
  const { bootCorePlugins, shutdownCorePlugins } = await import('@/core-plugins');
  const { coApp } = await import('@/plugins/co-app');
  shutdown = shutdownCorePlugins;
  bootCorePlugins();
  return coApp.panels.getAll().find((p) => p.type === 'settings')!;
}

afterEach(async () => {
  cleanup();
  await shutdown?.();
  shutdown = null;
  h.loadCategoryTabContent.mockClear();
  h.shellImported.mockClear();
});

describe('Settings 首开:外壳与分类内容 chunk 并行加载', () => {
  it('SettingsPanel lazy 工厂触发时同时发起 CategoryTabContent 加载(不等外壳渲染)', async () => {
    const spec = await bootSettingsSpec();
    expect(h.loadCategoryTabContent).not.toHaveBeenCalled(); // 注册期不加载(仍是懒加载)
    const view = render(createElement('div', null, spec.factory({})));
    // 外壳尚未渲染(分类 loader 永不 resolve 也不阻塞外壳)时,分类内容已发起
    expect(h.loadCategoryTabContent).toHaveBeenCalledTimes(1);
    expect(await view.findByTestId('settings-shell')).toBeTruthy();
    expect(h.shellImported).toHaveBeenCalledTimes(1);
  });

  // 首次点开「插件市场 / 插件 / 快捷键」页签内容区此前约 310ms 全空白(React.lazy 首次渲染必挂起、揭示被节流)。
  it('外壳 lazy 工厂同时预取插件市场 / 插件 / 快捷键页签 chunk:外壳出现后首次点开这些页签,内容同步渲染(不经 Suspense 回退)', async () => {
    const spec = await bootSettingsSpec();
    const view = render(createElement('div', null, spec.factory({})));
    expect(await view.findByTestId('settings-shell')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0)); // 预取 Promise 链结算
    const { coApp } = await import('@/plugins/co-app');
    for (const [id, testId] of [
      ['core.marketplace', 'tab-marketplace'],
      ['core.plugins', 'tab-plugins'],
      ['core.keybindings', 'tab-keybindings'],
    ] as const) {
      const tab = coApp.settingTabs.get(id)!;
      const tabView = render(createElement('div', null, tab.render()));
      // 同步:render 后不 await 就已有内容
      expect(tabView.queryByTestId(testId)).not.toBeNull();
      tabView.unmount();
    }
  });

  it('分类内容预取失败不影响设置外壳加载', async () => {
    h.loadCategoryTabContent.mockImplementationOnce(() => Promise.reject(new Error('chunk')));
    const spec = await bootSettingsSpec();
    const view = render(createElement('div', null, spec.factory({})));
    expect(await view.findByTestId('settings-shell')).toBeTruthy();
    expect(h.loadCategoryTabContent).toHaveBeenCalledTimes(1);
  });
});
