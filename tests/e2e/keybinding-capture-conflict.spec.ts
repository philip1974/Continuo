// 编辑 hotkey 时按下已绑定的组合 → 冲突警告显示.
import { test, expect } from './fixtures/electron-app';

test('register e2e.X (mod+shift+t) → 编辑 settings.open → 按 t → 警告', async ({
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
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '快捷键', exact: true })
    .click();
  await expect(window.locator('main li').first()).toBeVisible({
    timeout: 10_000,
  });
  // 找 settings.open(打开 Settings)行 → 其 编辑 按钮
  const settingsRow = window
    .locator('main li')
    .filter({ hasText: '打开 Settings' });
  await expect(settingsRow.first()).toBeVisible({ timeout: 5_000 });
  await settingsRow.first().locator('button[aria-label="编辑快捷键"]').click();
  await expect(window.locator('text=设置快捷键').first()).toBeVisible();

  // 按 mod+shift+t(capture 阶段需 dispatchEvent 才能稳)
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 't',
        ctrlKey: true,
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
  const dialogText = await dialog.textContent();
  console.log('[debug] dialog text:', dialogText);

  // 冲突警告 - dialog 内
  await expect(dialog).toContainText(/此组合已绑定/, { timeout: 5_000 });
});
