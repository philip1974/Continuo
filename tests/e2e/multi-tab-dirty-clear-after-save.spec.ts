// 多 tab + Cmd+S → 对应 a.ts tab 的 dirty dot 消失.
import { test, expect } from './fixtures/with-workspace';

test('2 tabs:改 a.ts → dirty dot 出 → Cmd+S → 清', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // save-me');

  const aItem = window
    .locator('main [role=tablist]')
    .first()
    .locator('div.wm-tab-nav-item', { hasText: 'a.ts' });

  await expect(aItem.locator('.wm-tab-nav-item__dirty-dot')).toHaveCount(1, {
    timeout: 5_000,
  });

  await cm.press('ControlOrMeta+KeyS');

  await expect(aItem.locator('.wm-tab-nav-item__dirty-dot')).toHaveCount(0, {
    timeout: 5_000,
  });
});
