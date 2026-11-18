// Splash 启动后短时间内消失(layout ready 即移除,无最短展示时长).
import { test, expect } from './fixtures/electron-app';

test('splash 启动后消失 + 主 shell 显示', async ({ window }) => {
  // 主 shell 元素出现 → splash 应已消失
  const splash = window.locator('[data-testid="splash"]');
  // 给 splash 最大 5s 消失;布局就绪即移除
  await expect(splash).toBeHidden({ timeout: 5_000 });

  // 主 shell 框架(footer + IconSidebar)可见
  await expect(window.locator('footer')).toBeVisible();
  await expect(window.locator('aside').first()).toBeVisible();
});
