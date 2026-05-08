// TabNav 切 tab → wm-tab-nav-item data-active 同步;data-active=true 的只有 1 个.
import { test, expect } from './fixtures/with-workspace';

test('切 tab → 当前 item data-active=true,其他 false', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  // 现在 active = a.ts

  const items = window
    .locator('main [role=tablist]')
    .first()
    .locator('div.wm-tab-nav-item');
  await expect(items).toHaveCount(2);

  const aItem = items.filter({ hasText: 'a.ts' });
  const readmeItem = items.filter({ hasText: 'README.md' });
  await expect(aItem).toHaveAttribute('data-active', 'true');
  await expect(readmeItem).toHaveAttribute('data-active', 'false');

  // 点 README.md tab
  await readmeItem.locator('button[role=tab]').click();
  await expect(window.locator('header').first()).toContainText('README.md');

  await expect(readmeItem).toHaveAttribute('data-active', 'true');
  await expect(aItem).toHaveAttribute('data-active', 'false');
});
