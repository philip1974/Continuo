// 面板弹出到子窗后,主窗齿轮打开的设置落在主窗(不进子窗);再点齿轮关闭主窗里的设置(BDD:popout-open-target)。
import { test, expect } from './fixtures/electron-app';
import { DOCK_POPOUT } from './helpers/editor';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('editor 弹出到子窗后点齿轮 → 设置在主窗打开;再点齿轮 → 主窗设置关闭', async ({ electronApp, window }) => {
  const popoutBtn = window.getByRole('button', { name: DOCK_POPOUT });
  await expect(popoutBtn).toBeEnabled({ timeout: 10_000 });
  await popoutBtn.click();
  await expect.poll(() => electronApp.windows().length).toBeGreaterThan(1);
  const child = electronApp.windows().find((w) => w !== window)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(child.locator('[data-testid=popout-host]')).toBeVisible({ timeout: 10_000 });

  await window.bringToFront();
  const gear = window.getByRole('button', { name: SETTINGS });
  await gear.click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({ timeout: 10_000 });
  await expect(child.getByRole('navigation', { name: SETTINGS_NAV })).toHaveCount(0);

  await gear.click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeHidden({ timeout: 5_000 });
});
