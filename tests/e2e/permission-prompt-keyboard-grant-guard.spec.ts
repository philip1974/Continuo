// PermissionPrompt:授予按钮的键盘激活须是停顿后的有意按键(真实 Chromium 的键盘 / 焦点事件;jsdom 规范见
// src/__tests__/permission-prompt/keyboard-grant-guard.spec.tsx)。
import { test, expect } from './fixtures/electron-app';
import {
  PERMISSION_DENY_ALL,
  PERMISSION_GRANT_ARM_WAIT_MS,
  PERMISSION_GRANT_SELECTED,
} from './helpers/permission-prompt';
import { waitForTestHooks } from './helpers/app-ready';

test('Tab→Enter 快速序列不授予;停顿后 Enter 授予;Shift+Tab 不从首元素回绕到授予按钮', async ({
  window,
}) => {
  await waitForTestHooks(window);

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

test('过早的真实鼠标点击被拒后焦点不留在授予按钮上:停顿后的 Enter 不授予', async ({ window }) => {
  await waitForTestHooks(window);

  await window.evaluate(() => {
    const w = window as unknown as {
      __continuoTest: {
        requestPermissions: (
          id: string,
          perms: readonly string[],
        ) => Promise<readonly string[]>;
      };
      __earlyGranted?: readonly string[];
    };
    void w.__continuoTest
      .requestPermissions('com.early', ['fs', 'network'])
      .then((granted) => {
        w.__earlyGranted = granted;
      });
  });
  const granted = () =>
    window.evaluate(
      () =>
        (window as unknown as { __earlyGranted?: readonly string[] }).__earlyGranted ?? null,
    );

  const modal = window.locator('.wm-modal-content');
  const denyBtn = modal.locator('button').filter({ hasText: PERMISSION_DENY_ALL });
  const grantBtn = modal.locator('button').filter({ hasText: PERMISSION_GRANT_SELECTED });
  // 弹窗一出现就按坐标点「授权选中」(真实的 mousedown / mouseup / click;不走 locator.click 的可操作性等待,
  // 保证落在出现后的防误触时间窗内)。Chromium 默认在 mousedown 时把焦点移到按钮上。
  await grantBtn.waitFor({ state: 'visible' });
  const box = await grantBtn.boundingBox();
  if (box === null) throw new Error('grant button has no bounding box');
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // 点击被拒(弹窗还在、有提示),焦点没有移到授予按钮上
  await expect(modal.locator('[role="status"]')).not.toBeEmpty();
  expect(await granted()).toBeNull();
  await expect(grantBtn).not.toBeFocused();
  await expect(denyBtn).toBeFocused();

  // 停顿后按 Enter:落在「全部拒绝」上,不是授予
  await window.waitForTimeout(700);
  await window.keyboard.press('Enter');
  await expect(modal).toBeHidden();
  expect(await granted()).toEqual([]);
});
