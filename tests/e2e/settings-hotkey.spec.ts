// settings.open 命令的 hotkey ⌘, 真实触发 → 打开 SettingsPanel.
import { test, expect } from './fixtures/electron-app';

test('Cmd/Ctrl+, → 打开 SettingsPanel', async ({ window }) => {
  // 等 app ready(useCommandHotkeys 挂载 + commands registry 注册 settings.open).
  // 用 IconSidebar 设置齿轮按钮可见作为就绪指标.
  await expect(window.locator('button[title="设置"]')).toBeVisible({
    timeout: 10_000,
  });

  // 直发 keydown 到 document(useCommandHotkeys 用 document.addEventListener)
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ',',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
});
