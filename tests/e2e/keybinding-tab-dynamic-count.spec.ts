// keybinding tab 计数随动态注册带 hotkey 命令变化.
import { test, expect } from './fixtures/electron-app';
import { KEYBINDINGS_TAB, openSettingsTab } from './helpers/settings';
import { waitForTestHooks } from './helpers/app-ready';

const KEYBINDINGS_TOTAL =
  /(共\s*\d+\s*个命令[,，]\d+\s*个已绑定|\d+\s*commands, \d+ bound|명령어\s*\d+개, \d+개 바인딩됨)/;

test('register e2e.X(hotkey)→ keybindings tab 计数 +1', async ({ window }) => {
  await waitForTestHooks(window);

  // 打开 Settings → 快捷键 tab
  await openSettingsTab(window, KEYBINDINGS_TAB);

  await expect(window.getByText(KEYBINDINGS_TOTAL)).toBeVisible({
    timeout: 10_000,
  });

  const before = await window
    .getByText(KEYBINDINGS_TOTAL)
    .first()
    .textContent();
  const beforeNum = Number(before?.match(/(\d+)/)?.[1] ?? '0');

  // register
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.registerCommand('e2e.kbd-count', 'KbdCount', 'mod+alt+z');
  });

  // 计数 +1
  await expect(async () => {
    const after = await window
      .getByText(KEYBINDINGS_TOTAL)
      .first()
      .textContent();
    const afterNum = Number(after?.match(/(\d+)/)?.[1] ?? '0');
    expect(afterNum).toBe(beforeNum + 1);
  }).toPass({ timeout: 5_000 });
});

// 对齐 VSCode:无默认快捷键的命令也列出,显示「未绑定」,可直接录键。
test('register 无 hotkey 命令 → 快捷键 tab 列出该行并显示未绑定', async ({ window }) => {
  await waitForTestHooks(window);
  await openSettingsTab(window, KEYBINDINGS_TAB);
  await expect(window.getByText(KEYBINDINGS_TOTAL)).toBeVisible({ timeout: 10_000 });

  await window.evaluate(() => {
    globalThis.__continuoTest!.registerCommand('e2e.kbd-unbound', 'KbdUnboundCmd');
  });

  const row = window.locator('main li').filter({ hasText: 'KbdUnboundCmd' });
  await expect(row).toBeVisible({ timeout: 5_000 });
  await expect(row).toContainText(/未绑定|Unbound|바인딩 없음/);
});
