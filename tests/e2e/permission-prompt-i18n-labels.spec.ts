// PermissionPrompt 显示中文权限 label(文件系统 / 网络访问 等),不是 raw 'fs' / 'network'.
import { test, expect } from './fixtures/electron-app';

test('请求 fs/network/clipboard → 显「文件系统」「网络访问」「剪贴板」中文 label', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

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
  // 中文 label 出现
  await expect(modal).toContainText('文件系统');
  await expect(modal).toContainText('网络访问');
  await expect(modal).toContainText('剪贴板');
});
