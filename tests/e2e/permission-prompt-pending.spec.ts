// PermissionPrompt 已 pending 时,第二次 request → 自身 store.request 实际
// resolve previous resolver. 看 promptStore 行为:目前实现只允许一个 pending,
// 第二次会覆盖 pending → 旧 promise 被替换,但 e2e 内难强同步验证.
//
// 简化:验证「同一时刻只看到 1 个 modal」,无论 fire 多少次 requestPermissions.

import { test, expect } from './fixtures/electron-app';

test('连续 2 次 requestPermissions → 仍只 1 个 modal 渲染', async ({
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
    void t.requestPermissions('com.first', ['fs']);
    // 立刻第二次
    void t.requestPermissions('com.second', ['network']);
  });

  // Modal 只有 1 个 .wm-modal-content
  await expect(window.locator('.wm-modal-content')).toHaveCount(1, {
    timeout: 5_000,
  });
});
