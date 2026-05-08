// 单击 src 文件夹 → 展开 / 收起 toggle.
import { test, expect } from './fixtures/with-workspace';

test('点 src toggle:展开 → 收 → 展开', async ({ window }) => {
  const aTs = window.locator('[role=treeitem]').filter({ hasText: /^a\.ts$/ });
  // 默认 src 折叠 → a.ts 不显
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
