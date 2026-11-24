// PermissionPrompt 显 plugin id;含特殊字符的 id 不破坏渲染.
import { test, expect } from './fixtures/electron-app';
import { waitForTestHooks } from './helpers/app-ready';

test('plugin id 含点 / 横杠 / 下划线 → modal 仍正常渲染', async ({
  window,
}) => {
  await waitForTestHooks(window);

  const ID = 'co.example-plugin_v2.test';
  await window.evaluate((id) => {
    const t = globalThis.__continuoTest!;
    void t.requestPermissions(id, ['fs']);
  }, ID);

  const modal = window.locator('.wm-modal-content');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText(ID);
});
