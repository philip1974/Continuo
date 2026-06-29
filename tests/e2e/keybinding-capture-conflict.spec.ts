// 编辑 hotkey 时按下已绑定的组合 → 冲突警告显示.
import { test, expect } from './fixtures/electron-app';
import {
  EDIT_HOTKEY_SELECTOR,
  KEYBINDING_CAPTURE_MODAL,
  KEYBINDING_CONFLICT_WARNING,
  KEYBINDINGS_TAB,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('register e2e.X (mod+shift+t) → 编辑 settings.toggle → 按 t → 警告', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 注册一个用 mod+shift+t 的命令
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          registerCommand: (
            id: string,
            title: string,
            hotkey?: string,
          ) => () => void;
        };
      }
    ).__continuoTest;
    t.registerCommand('e2e.conflict-target', 'Conflict Target', 'mod+shift+t');
  });

  // 打开 Settings → 快捷键 tab → 第一个编辑按钮
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: KEYBINDINGS_TAB })
    .click();
  await expect(window.locator('main li').first()).toBeVisible({
    timeout: 10_000,
  });
  // 找 settings.toggle 行 → 其编辑按钮
  const settingsRow = window.locator('main li').filter({ hasText: 'settings.toggle' });
  await expect(settingsRow.first()).toBeVisible({ timeout: 5_000 });
  await settingsRow.first().locator(EDIT_HOTKEY_SELECTOR).click();
  await expect(window.getByText(KEYBINDING_CAPTURE_MODAL).first()).toBeVisible();

  // 按 mod+shift+t(capture 阶段需 dispatchEvent 才能稳)
  await window.evaluate(() => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 't',
        ctrlKey: !isMac,
        metaKey: isMac,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  // 等 capture 状态更新
  await window.waitForTimeout(300);

  // 检查 dialog 内 captured combo
  const dialog = window.locator('.wm-modal-content').last();

  // 冲突警告 - dialog 内
  await expect(dialog).toContainText(KEYBINDING_CONFLICT_WARNING, {
    timeout: 5_000,
  });
});
