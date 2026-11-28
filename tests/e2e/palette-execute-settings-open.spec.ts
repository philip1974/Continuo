// CommandPalette 选择「首选项: 打开设置」(workbench.action.openSettings)→ Settings panel 出;已显示时再执行不关闭(同 VSCode)。
import { test, expect } from './fixtures/electron-app';
import {
  commandPaletteInput,
  openCommandPalette,
  filterToSettingsCommand,
} from './helpers/palette';
import { SETTINGS_NAV } from './helpers/settings';
import { dispatchModKey } from './helpers/hotkeys';

test('Cmd+Shift+P → 选择 Settings 命令 → Settings nav 出', async ({
  window,
}) => {
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await expect(input).toBeVisible();
  const option = await filterToSettingsCommand(window);
  await expect(option).toBeVisible();

  await option.click();
  await expect(input).toBeHidden({ timeout: 5_000 });

  // Settings nav
  await expect(
    window.getByRole('navigation', { name: SETTINGS_NAV }),
  ).toBeVisible({ timeout: 5_000 });
});

test('设置已显示时再执行「首选项: 打开设置」→ 仍显示(不切换);⌘, 照旧收回', async ({ window }) => {
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  for (let i = 0; i < 2; i++) {
    await openCommandPalette(window);
    const option = await filterToSettingsCommand(window);
    await expect(option).toBeVisible();
    await option.click();
    await expect(commandPaletteInput(window)).toBeHidden({ timeout: 5_000 });
    await expect(nav).toBeVisible({ timeout: 5_000 });
  }
  await window.waitForTimeout(400); // 关闭动画(若误关)走完再断言
  await expect(nav).toBeVisible();
  await dispatchModKey(window, ',');
  await expect(nav).toBeHidden({ timeout: 5_000 });
});
