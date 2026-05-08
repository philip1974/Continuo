// 改 a.ts → 切 b.ts → 切回 → CM 仍显修改后内容(store 持有 dirty content).
import { test, expect } from './fixtures/with-workspace';

test('a.ts 改 → 切 b.ts → 切回 a.ts → 修改仍在', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(' // dirty-keep');

  // 切 b.ts
  await window.locator('text=b.ts').first().click();
  await expect(window.locator('header').first()).toContainText('b.ts');
  // CM 现在显 b.ts 内容
  await expect(window.locator('.cm-content').first()).toContainText(
    'export const b',
  );

  // 切回 a.ts
  const aTab = window
    .locator('main [role=tablist]')
    .first()
    .locator('[role=tab]')
    .filter({ hasText: 'a.ts' });
  await aTab.click();
  await expect(window.locator('header').first()).toContainText('a.ts');

  // CM 应仍含 dirty-keep
  await expect(window.locator('.cm-content').first()).toContainText(
    'dirty-keep',
    { timeout: 5_000 },
  );
});
