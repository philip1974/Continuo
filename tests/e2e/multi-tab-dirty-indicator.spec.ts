// 多 tab 模式 → 改 a.ts → a.ts TabNavItem data-dirty=true.
import { test, expect } from './fixtures/with-workspace';

test('开 2 tabs → 改 a.ts → a.ts tab data-dirty=true; README.md tab=false', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts');

  // wm-tab-nav-item 是 div 容器(button role=tab 是其子)
  const aItem = window
    .locator('main [role=tablist]')
    .first()
    .locator('div.wm-tab-nav-item', { hasText: 'a.ts' });
  const readmeItem = window
    .locator('main [role=tablist]')
    .first()
    .locator('div.wm-tab-nav-item', { hasText: 'README.md' });

  // 默认全无 dirty
  await expect(aItem.locator('.wm-tab-nav-item__dirty-dot')).toHaveCount(0);
  await expect(
    readmeItem.locator('.wm-tab-nav-item__dirty-dot'),
  ).toHaveCount(0);

  // 改 a.ts → 它 dirty
  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 5_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');

  // a.ts dirty dot 出现
  await expect(aItem.locator('.wm-tab-nav-item__dirty-dot')).toHaveCount(1, {
    timeout: 5_000,
  });
  // README.md 仍 不 dirty
  await expect(
    readmeItem.locator('.wm-tab-nav-item__dirty-dot'),
  ).toHaveCount(0);
});
