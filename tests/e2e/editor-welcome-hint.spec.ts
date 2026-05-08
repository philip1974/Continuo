// EditorWelcome 默认 hint 含「在 Explorer 单击文件打开」+ ⌘ + S + 「保存」文案.
import { test, expect } from './fixtures/electron-app';

test('启动后 → EditorWelcome 显完整 hint', async ({ window }) => {
  await expect(window.getByText('未打开文件').first()).toBeVisible({
    timeout: 5_000,
  });
  await expect(
    window.getByText(/在\s*Explorer\s*单击文件打开/),
  ).toBeVisible();
  // KeyCap ⌘ S
  const main = window.locator('main');
  await expect(main).toContainText('⌘');
  await expect(main).toContainText('S');
  await expect(main).toContainText('保存');
});
