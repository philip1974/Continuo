// F2 rename → editor tab title 同步.
import { test, expect } from './fixtures/with-workspace';

test('打开 a.ts → F2 → renamed.ts → header 同步', async ({ window }) => {
  await window.locator('text=src').first().click();
  const aRow = window.locator('text=a.ts').first();
  await aRow.click();
  await expect(window.locator('header').first()).toContainText('a.ts');

  await aRow.press('F2');
  const input = window.locator('input:focus');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.press('ControlOrMeta+KeyA');
  await input.fill('renamed.ts');
  await input.press('Enter');

  await expect(window.locator('header').first()).toContainText('renamed.ts', {
    timeout: 5_000,
  });
});
