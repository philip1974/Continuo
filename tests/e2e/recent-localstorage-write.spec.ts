// CommandPalette recent 持久化:执行命令 → localStorage 'continuo:command-palette:recent'.
import { test, expect } from './fixtures/electron-app';
import {
  commandPaletteInput,
  openCommandPalette,
  filterToSettingsCommand,
} from './helpers/palette';
import { SETTINGS } from './helpers/settings';

test('执行「首选项: 打开设置」→ localStorage recent 含 workbench.action.openSettings id', async ({
  window,
}) => {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });

  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await expect(input).toBeVisible();
  const option = await filterToSettingsCommand(window);
  await expect(option).toBeVisible();
  await option.click();
  await expect(input).toBeHidden();

  // localStorage 写入
  const raw = await window.evaluate(() =>
    localStorage.getItem('continuo:command-palette:recent'),
  );
  expect(raw).not.toBeNull();
  const list = JSON.parse(raw!) as Array<{ id: string; ts: number }>;
  expect(list[0]?.id).toBe('workbench.action.openSettings');
});
