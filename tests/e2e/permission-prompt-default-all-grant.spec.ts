// PermissionPrompt 默认全选 → 直接「授权选中(N)」 → resolve 含全部.
import { test, expect } from './fixtures/electron-app';
import {
  PERMISSION_GRANT_SELECTED,
  permissionGrantSelectedText,
} from './helpers/permission-prompt';

test('请求 fs+network+clipboard → 默认全选 → 授权 → resolve 三项', async ({
  window,
}) => {
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
    return t.requestPermissions('com.all', ['fs', 'network', 'clipboard']);
  });

  const modal = window.locator('.wm-modal-content');
  await expect(modal).toBeVisible();
  // 「授权选中(3)」
  await expect(
    modal.locator('button').filter({ hasText: PERMISSION_GRANT_SELECTED }),
  ).toHaveText(permissionGrantSelectedText(3));

  await modal
    .locator('button')
    .filter({ hasText: PERMISSION_GRANT_SELECTED })
    .click();

  const granted = (await grantedPromise) as readonly string[];
  // 顺序不严格,但应含三项
  expect(granted).toHaveLength(3);
  expect(granted).toContain('fs');
  expect(granted).toContain('network');
  expect(granted).toContain('clipboard');
});
