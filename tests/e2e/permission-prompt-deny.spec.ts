// PermissionPrompt 拒绝按钮 → resolve 空数组(没授权).
import { test, expect } from './fixtures/electron-app';
import { PERMISSION_DENY_ALL } from './helpers/permission-prompt';

test('点「拒绝」 → Promise resolve []', async ({ window }) => {
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
    return t.requestPermissions('com.deny', ['fs', 'network']);
  });

  const modal = window.locator('.wm-modal-content');
  await expect(modal).toBeVisible();

  // 「拒绝」按钮(promptStore.deny → resolve [])
  const denyBtn = modal.locator('button').filter({ hasText: PERMISSION_DENY_ALL });
  await denyBtn.click();

  const granted = (await grantedPromise) as readonly string[];
  expect(granted).toEqual([]);
  await expect(modal).toBeHidden();
});
