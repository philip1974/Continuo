// 冒烟:Electron 进程能起来 + renderer 能挂上 React + 关键 shell 元素就位.
// 这是 e2e 的"门"——失败说明 build/main/preload/renderer 任意一段烂了.

import { test, expect } from './fixtures/electron-app';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('app 启动后渲染基本 shell 框架', async ({ window }) => {
  // 标题栏:无工作区 + 无 active tab 时 fallback 「Continuo」
  await expect(window.locator('header').first()).toContainText('Continuo');

  // 左侧 IconSidebar(48px aside):Explorer 开关 + 设置齿轮 + AccountChip
  const iconSidebar = window.locator('aside').first();
  await expect(iconSidebar).toBeVisible();

  // Explorer 切换按钮(通过 aria-label 或 title 定位)
  const explorerToggle = window.locator(
    'button[title*="Explorer"]',
  );
  await expect(explorerToggle).toHaveCount(1);

  // 底部 StatusBar(footer)
  await expect(window.locator('footer')).toBeVisible();
});

test('renderer 暴露 __lmApi(preload contextBridge 工作)', async ({ window }) => {
  const hasLmApi = await window.evaluate(() => {
    const w = window as unknown as { __lmApi?: unknown };
    return Boolean(w.__lmApi);
  });
  expect(hasLmApi).toBe(true);
});

test('Settings 齿轮点击打开 Settings panel', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();

  // dockview 创建 panel 后,内容区出现「设置」相关 settings tab nav
  // 「通用 / 编辑器 / 资源管理器 / 终端 / 快捷键 / 插件 / 商店」中至少有一项
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
});
