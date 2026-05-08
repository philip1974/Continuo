// PermissionPrompt UI:plugin 请求权限时弹 Modal,默认全选,授权 / 拒绝.
//
// 通过 testing hook 调 promptStore.request → modal 出现.
import { test, expect } from './fixtures/electron-app';

test('请求 fs/network 权限 → modal 列出两条,默认全选 + 授权按钮显数', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 触发 prompt(fire-and-forget — 当前 spec 不验证 promise 结果)
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
    void t.requestPermissions('com.example.test', ['fs', 'network']);
  });

  // Modal 弹出 + 列出 fs / network 两个 checkbox
  const modal = window.locator('.wm-modal-content');
  await expect(modal).toBeVisible();
  // 文案含 plugin id
  await expect(modal).toContainText('com.example.test');
  // 两个 checkbox
  const cbs = modal.locator('input[type=checkbox]');
  await expect(cbs).toHaveCount(2);
  // 默认全选
  expect(await cbs.first().isChecked()).toBe(true);
  expect(await cbs.last().isChecked()).toBe(true);
  // 授权按钮显数 (2)
  await expect(modal).toContainText(/授权选中.*2.*/);

  // 取消其中一个
  await cbs.first().click();
  await expect(modal).toContainText(/授权选中.*1.*/);
});

test('点「授权选中」→ Promise resolve 含勾选项', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 让 evaluate 返 promise 结果
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
    return t.requestPermissions('com.example.x', ['fs']);
  });

  const modal = window.locator('.wm-modal-content');
  await expect(modal).toBeVisible();
  // 点「授权选中」(默认全选 1 个)— 文本搜:「授权选中(1)」
  const grantBtn = modal
    .locator('button')
    .filter({ hasText: /授权选中/ });
  await grantBtn.click();

  const granted = (await grantedPromise) as readonly string[];
  expect(granted).toEqual(['fs']);
  await expect(modal).toBeHidden();
});
