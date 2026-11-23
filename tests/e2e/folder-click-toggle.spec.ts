// 单击 src 文件夹 → 展开 / 收起 toggle.
import { test, expect } from './fixtures/with-workspace';
import { explorerTreeItem } from './helpers/explorer';

test('点 src toggle:展开 → 收 → 展开', async ({ window }) => {
  const aTs = window.locator('[role=treeitem]').filter({ hasText: /^a\.ts$/ });
  // 先等树渲染出 src(否则 a.ts 计数为 0 首帧即成立),再确认默认折叠 → a.ts 不显
  await expect(explorerTreeItem(window, /^src$/)).toBeVisible({ timeout: 10_000 });
  await expect(aTs).toHaveCount(0);

  // 第一次点 → 展开
  await window.locator('text=src').first().click();
  await expect(aTs).toBeVisible({ timeout: 5_000 });

  // 第二次点 → 收起
  await window.locator('text=src').first().click();
  await expect(aTs).toHaveCount(0, { timeout: 5_000 });

  // 第三次点 → 再展开
  await window.locator('text=src').first().click();
  await expect(aTs).toBeVisible({ timeout: 5_000 });
});
