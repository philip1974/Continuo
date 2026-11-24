// 改 → reset → 重启 → input 仍 default(13).
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clickFirstVisibleResetDefault,
  EDITOR_TAB,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';
import { launchContinuo } from './helpers/launch';

test('改 → reset → 重启同 ud → fontSize input 仍 13', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-rstp-'));
  try {
    const app1 = await launchContinuo(ud);
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    await win1.getByRole('button', { name: SETTINGS }).click();
    await expect(win1.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
      timeout: 10_000,
    });
    await win1
      .getByRole('navigation', { name: SETTINGS_NAV })
      .getByRole('button', { name: EDITOR_TAB })
      .dispatchEvent('click');

    const fi1 = win1.locator('input[type=number]').first();
    await fi1.fill('20');
    await win1.waitForTimeout(150);
    await clickFirstVisibleResetDefault(win1);
    await expect(fi1).toHaveValue('13');
    await win1.waitForTimeout(200);
    await app1.close();

    // reload
    const app2 = await launchContinuo(ud);
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // 不点齿轮:win1 关闭时 Settings 处于打开状态,重启恢复出的 active Settings 会被 toggle 关掉
    // (toggle-settings-panel 契约)。用幂等的 openOrFocusPanel 确保打开,与点击时机无关。
    await win2.waitForFunction(
      () => Boolean((window as unknown as { __continuoTest?: unknown }).__continuoTest),
      { timeout: 5_000 },
    );
    // dock 未就绪(DockShell onReady 前)时 openOrFocusPanel 按契约静默忽略;测试钩子可能更早可用。
    // 出现 dock 页签 = 布局已恢复(fromJSON / 默认布局);Splash 不在 = 就绪屏障已放行。
    await expect(win2.getByRole('tab').first()).toBeVisible({ timeout: 10_000 });
    await expect(win2.getByTestId('splash')).toHaveCount(0, { timeout: 10_000 });
    await win2.evaluate(() => {
      (
        window as unknown as {
          __continuoTest: {
            openOrFocusPanel: (id: string, component: string, title: string) => void;
          };
        }
      ).__continuoTest.openOrFocusPanel('settings', 'settings', 'Settings');
    });
    await expect(win2.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
      timeout: 10_000,
    });
    await win2
      .getByRole('navigation', { name: SETTINGS_NAV })
      .getByRole('button', { name: EDITOR_TAB })
      .dispatchEvent('click');
    await expect(win2.locator('input[type=number]').first()).toHaveValue('13');
    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
