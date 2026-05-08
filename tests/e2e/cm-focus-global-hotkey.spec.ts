// CodeMirror 聚焦时 → Cmd+Shift+P 仍打开命令面板.
// useCommandHotkeys 用 document.addEventListener,CM 不阻断 keydown bubble.
import { test, expect } from './fixtures/with-workspace';

test('CM 聚焦 + Cmd+Shift+P → 命令面板打开', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();

  // 直接 dispatchEvent 在 CM 上,验证 document 级监听仍能 capture
  await cm.press('ControlOrMeta+Shift+KeyP');

  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible({ timeout: 5_000 });
});
