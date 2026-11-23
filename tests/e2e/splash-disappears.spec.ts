// Splash 启动后短时间内消失(layout ready 即移除,无最短展示时长).
import { test, expect } from './fixtures/electron-app';

test('splash 启动后消失 + 主 shell 显示', async ({ window }) => {
  // footer 与 Splash 在同一次 React 提交中渲染:先等 footer 出现(此时 Splash 已挂上),
  // 再给 Splash 最大 5s 撤除(布局就绪即移除)。直接断言 hidden 会在 render 前恒真。
  await expect(window.locator('footer')).toBeVisible({ timeout: 15_000 });
  const splash = window.getByTestId('splash');
  await expect(splash).toBeHidden({ timeout: 5_000 });

  // 主 shell 框架(IconSidebar)可见
  await expect(window.locator('aside').first()).toBeVisible();
});
