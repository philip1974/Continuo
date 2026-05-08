// 多文件依次打开 → TabNav 顺序保持(open 顺序).
import { test, expect } from './fixtures/with-workspace';

test('依次开 README.md → a.ts → b.ts → tab 顺序固定', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await window.locator('text=b.ts').first().click();

  const tabs = window
    .locator('main [role=tablist]')
    .first()
    .locator('[role=tab]');
  await expect(tabs).toHaveCount(3);

  // 顺序:README.md → a.ts → b.ts
  await expect(tabs.nth(0)).toContainText('README.md');
  await expect(tabs.nth(1)).toContainText('a.ts');
  await expect(tabs.nth(2)).toContainText('b.ts');
});
