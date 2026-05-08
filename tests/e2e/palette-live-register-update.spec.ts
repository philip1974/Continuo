// palette 开后注册新命令 → 列表立即含(commands.subscribe).
import { test, expect } from './fixtures/electron-app';

test('palette 开 → register e2e.live → 列表立即含', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 开 palette
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible();
  // 输预期不存在的字符串
  await input.fill('LiveRegistered');
  await expect(window.locator('.wm-modal-content')).toContainText(
    '无匹配命令',
  );

  // 注册命令
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          registerCommand: (id: string, title: string) => () => void;
        };
      }
    ).__continuoTest;
    t.registerCommand('e2e.live', 'LiveRegistered Cmd');
  });

  // 列表应立即更新 → 含命令
  await expect(
    window.locator('.wm-modal-content li').first(),
  ).toContainText('LiveRegistered', { timeout: 3_000 });
});
