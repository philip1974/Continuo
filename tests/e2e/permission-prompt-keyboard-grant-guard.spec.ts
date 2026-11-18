// PermissionPrompt:授予按钮的键盘激活须是停顿后的有意按键(真实 Chromium 的键盘 / 焦点事件;jsdom 规范见
// src/__tests__/permission-prompt/keyboard-grant-guard.spec.tsx)。
import { test, expect } from './fixtures/electron-app';
import {
  PERMISSION_DENY_ALL,
  PERMISSION_GRANT_ARM_WAIT_MS,
  PERMISSION_GRANT_SELECTED,
} from './helpers/permission-prompt';

test('Tab→Enter 快速序列不授予;停顿后 Enter 授予;Shift+Tab 不从首元素回绕到授予按钮', async ({
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
    const w = window as unknown as {
      __continuoTest: {
        requestPermissions: (
          id: string,
          perms: readonly string[],
        ) => Promise<readonly string[]>;
      };
      __kbGranted?: readonly string[];
    };
    void w.__continuoTest
      .requestPermissions('com.kb', ['fs', 'network'])
      .then((granted) => {
        w.__kbGranted = granted;
      });
  });
  const granted = () =>
    window.evaluate(
      () => (window as unknown as { __kbGranted?: readonly string[] }).__kbGranted ?? null,
    );

  const modal = window.locator('.wm-modal-content');
  await expect(modal).toBeVisible();
  const denyBtn = modal.locator('button').filter({ hasText: PERMISSION_DENY_ALL });
  const grantBtn = modal.locator('button').filter({ hasText: PERMISSION_GRANT_SELECTED });
  // 初始焦点在「全部拒绝」
  await expect(denyBtn).toBeFocused();

  // 首元素(第一个勾选框)上 Shift+Tab:焦点留在原处,不回绕到末尾的授予按钮
  const firstBox = modal.locator('input[type=checkbox]').first();
  await firstBox.focus();
  await window.keyboard.press('Shift+Tab');
  await expect(firstBox).toBeFocused();

  // 出现延迟过后:Tab 到授予按钮紧接着 Enter / Space → 不授予
  await denyBtn.focus();
  await window.waitForTimeout(PERMISSION_GRANT_ARM_WAIT_MS);
  await window.keyboard.press('Tab');
  await expect(grantBtn).toBeFocused();
  await window.keyboard.press('Enter');
  await window.keyboard.press('Space');
  await expect(modal).toBeVisible();
  expect(await granted()).toBeNull();

  // 停顿后有意按下 → 授予
  await window.waitForTimeout(PERMISSION_GRANT_ARM_WAIT_MS);
  await window.keyboard.press('Enter');
  await expect(modal).toBeHidden();
  expect(await granted()).toEqual(['fs', 'network']);
});
