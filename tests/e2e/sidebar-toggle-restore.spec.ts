// 关 sidebar → 内容隐;再开 → ExplorerSidebar 恢复 + README.md 仍可见.
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_HIDE, EXPLORER_SHOW } from './helpers/explorer';

test('sidebar 关 → 开 → ExplorerSidebar 内容恢复', async ({ window }) => {
  const aside = window.locator('main aside').nth(1);
  await expect(aside).toBeVisible();
  await expect(aside.locator('text=README.md')).toBeVisible();

  // 关
  await window.getByRole('button', { name: EXPLORER_HIDE }).first().click();
  await expect(aside).toBeHidden({ timeout: 5_000 });

  // 再开
  await window.getByRole('button', { name: EXPLORER_SHOW }).first().click();
  await expect(aside).toBeVisible({ timeout: 5_000 });
  await expect(aside.locator('text=README.md')).toBeVisible();
});
