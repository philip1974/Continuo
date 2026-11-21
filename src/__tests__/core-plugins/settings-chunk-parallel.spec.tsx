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

  it('分类内容预取失败不影响设置外壳加载', async () => {
    h.loadCategoryTabContent.mockImplementationOnce(() => Promise.reject(new Error('chunk')));
    const spec = await bootSettingsSpec();
    const view = render(createElement('div', null, spec.factory({})));
    expect(await view.findByTestId('settings-shell')).toBeTruthy();
    expect(h.loadCategoryTabContent).toHaveBeenCalledTimes(1);
  });
});
