// PermissionPrompt 默认全选 → 直接「授权选中(N)」 → resolve 含全部.
import { test, expect } from './fixtures/electron-app';
import {
  PERMISSION_GRANT_ARM_WAIT_MS,
  PERMISSION_GRANT_SELECTED,
  permissionGrantSelectedText,
} from './helpers/permission-prompt';
import { waitForTestHooks } from './helpers/app-ready';

test('请求 fs+network+clipboard → 默认全选 → 授权 → resolve 三项', async ({
  window,
}) => {
  await waitForTestHooks(window);

  const grantedPromise = window.evaluate(async () => {
    const t = globalThis.__continuoTest!;
    return t.requestPermissions('com.all', ['fs', 'network', 'clipboard']);
  });

  const modal = window.locator('.wm-modal-content');
  await expect(modal).toBeVisible();
  // 「授权选中(3)」
  await expect(
    modal.locator('button').filter({ hasText: PERMISSION_GRANT_SELECTED }),
  ).toHaveText(permissionGrantSelectedText(3));

  await window.waitForTimeout(PERMISSION_GRANT_ARM_WAIT_MS);
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
