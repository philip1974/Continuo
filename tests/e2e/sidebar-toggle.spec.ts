// Explorer 左侧栏的开/关切换 + 状态栏「侧栏已隐藏」hint.
import { test, expect } from './fixtures/electron-app';

test('点 Explorer 图标切换侧栏可见性 + 状态栏文案', async ({ window }) => {
  // 初始:sidebar 默认 open;StatusBar 不显「侧栏已隐藏」
  const statusBar = window.locator('footer');
  await expect(statusBar).toBeVisible();
  await expect(statusBar).not.toContainText('侧栏已隐藏');

  // ExplorerSidebar(aside)在 dock 之外、IconSidebar 与 dock 之间;
  // 它是 main 区域里第二个 aside;IconSidebar 在第一位。
  // 用 width 判定:IconSidebar 是 w-12(48px),ExplorerSidebar 是动态 width 默认 280px。
  const sidebars = window.locator('main aside');
  await expect(sidebars).toHaveCount(2);

  // 点 Explorer toggle 关闭
  await window.locator('button[title="隐藏 Explorer"]').click();

  // 现在只剩 IconSidebar
  await expect(sidebars).toHaveCount(1);
  // 状态栏出现「侧栏已隐藏」
  await expect(statusBar).toContainText('侧栏已隐藏');

  // 再点一次开回来
  await window.locator('button[title="显示 Explorer"]').click();
  await expect(sidebars).toHaveCount(2);
  await expect(statusBar).not.toContainText('侧栏已隐藏');
});
