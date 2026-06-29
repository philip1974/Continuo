// 加 Terminal 和 Settings 后,选择性关闭一个 → 另两个仍在.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('开 Editor + Terminal + Settings → 关 Settings → Editor + Terminal 仍在', async ({
  window,
}) => {
  // 等 testing hook 挂载
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 加 Terminal
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          openOrFocusPanel: (id: string, c: string, t: string) => void;
        };
      }
    ).__continuoTest;
    t.openOrFocusPanel('terminal', 'terminal', 'Terminal');
  });
  await expect(
    window.locator('button[aria-label="新建终端"]'),
  ).toBeVisible({ timeout: 10_000 });

  // 加 Settings
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });

  // 关 Settings
  await window.locator('button[aria-label="Close Settings"]').click();
  await window.waitForTimeout(400);

  // Editor SharedTab close + Terminal SharedTab close 仍在
  await expect(window.locator('button[aria-label="Close Editor"]')).toHaveCount(
    1,
  );
  await expect(
    window.locator('button[aria-label="Close Terminal"]'),
  ).toHaveCount(1);
  // Settings 没了
  await expect(
    window.locator('button[aria-label="Close Settings"]'),
  ).toHaveCount(0);
});
