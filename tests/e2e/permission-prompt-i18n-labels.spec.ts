// PermissionPrompt 显示本地化权限 label(文件系统 / File system 等),不是 raw 'fs' / 'network'.
import { test, expect } from './fixtures/electron-app';
import {
  PERMISSION_LABEL_CLIPBOARD,
  PERMISSION_LABEL_FS,
  PERMISSION_LABEL_NETWORK,
} from './helpers/permission-prompt';
import { waitForTestHooks } from './helpers/app-ready';

test('请求 fs/network/clipboard → 显本地化 permission label', async ({
  window,
}) => {
  await waitForTestHooks(window)

  await window.evaluate(() => {
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
    void t.requestPermissions('com.i18n', ['fs', 'network', 'clipboard']);
  });

  const modal = window.locator('.wm-modal-content');
  await expect(modal).toBeVisible();
  // 本地化 label 出现,而不是 raw permission key.
  await expect(modal.getByText(PERMISSION_LABEL_FS)).toBeVisible();
  await expect(modal.getByText(PERMISSION_LABEL_NETWORK)).toBeVisible();
  await expect(modal.getByText(PERMISSION_LABEL_CLIPBOARD)).toBeVisible();
});
