// PermissionPrompt:取消所有 checkbox + 「授权选中」(数量=0)→ resolve [].
import { test, expect } from './fixtures/electron-app';
import {
  PERMISSION_GRANT_SELECTED,
  permissionGrantSelectedText,
} from './helpers/permission-prompt';

test('全部 uncheck → 「授权选中(0)」 → resolve []', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  const grantedPromise = window.evaluate(async () => {
    const t = (
      window as unknown as {
        __continuoTest: {
          requestPermissions: (
            id: string,
            perms: readonly string[],
          ) => Promise<readonly string[]>;
        };
      }
    ).__continuoTest;
    return t.requestPermissions('com.zero', ['fs', 'network']);
  });

  const modal = window.locator('.wm-modal-content');
  await expect(modal).toBeVisible();

  // 取消两个 checkbox
  const cbs = modal.locator('input[type=checkbox]');
  await cbs.first().click(); // fs uncheck
  await cbs.last().click(); // network uncheck

  await expect(
    modal.locator('button').filter({ hasText: PERMISSION_GRANT_SELECTED }),
  ).toHaveText(permissionGrantSelectedText(0));

  // 点「授权选中」
  await modal
    .locator('button')
    .filter({ hasText: PERMISSION_GRANT_SELECTED })
    .click();

  const granted = (await grantedPromise) as readonly string[];
  expect(granted).toEqual([]);
  await expect(modal).toBeHidden();
});
