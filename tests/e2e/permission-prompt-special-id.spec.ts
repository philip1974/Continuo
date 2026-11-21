// PermissionPrompt 显 plugin id;含特殊字符的 id 不破坏渲染.
import { test, expect } from './fixtures/electron-app';

test('plugin id 含点 / 横杠 / 下划线 → modal 仍正常渲染', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  const ID = 'co.example-plugin_v2.test';
  await window.evaluate((id) => {
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
    void t.requestPermissions(id, ['fs']);
  }, ID);

  const modal = window.locator('.wm-modal-content');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText(ID);
});
