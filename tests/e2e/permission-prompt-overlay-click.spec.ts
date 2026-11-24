// PermissionPrompt overlay click → onClose → modal 关 + Promise resolve [](拒绝).
//
// design Modal 的 overlay 点击触发 onClose;PermissionPrompt 的 onClose 走
// promptStore.denyAll 路径 → resolve [].
import { test, expect } from './fixtures/electron-app';
import { waitForTestHooks } from './helpers/app-ready';

test('点 overlay → modal 关 + Promise resolve []', async ({ window }) => {
  await waitForTestHooks(window);

  const grantedPromise = window.evaluate(async () => {
    const t = globalThis.__continuoTest!;
    return t.requestPermissions('com.overlay', ['fs']);
  });

  const overlay = window.locator('.wm-modal-overlay');
  await expect(overlay).toBeVisible();
  await overlay.click({ position: { x: 5, y: 5 } });

  const granted = (await grantedPromise) as readonly string[];
  expect(granted).toEqual([]);
  await expect(window.locator('.wm-modal-content')).toBeHidden();
});
