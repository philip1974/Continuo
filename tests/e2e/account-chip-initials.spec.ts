// IconSidebar 底部 AccountChip 显「CD」.
import { test, expect } from './fixtures/electron-app';

test('AccountChip 文本含「CD」', async ({ window }) => {
  const chip = window.locator(
    'button[aria-label="账户:Continuo Dev,PRO Plan"]',
  );
  await expect(chip).toBeVisible({ timeout: 5_000 });
  await expect(chip).toHaveText('CD');
});
