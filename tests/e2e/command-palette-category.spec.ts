// CommandPalette 列表项含本地化 category prefix:'Settings: Toggle Settings'.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;
const COMMAND_LIST = /^(命令列表|Command list|명령어 목록)$/;
const SETTINGS_CATEGORY = /(设置|Settings|설정)/;
const SETTINGS_TITLE = /(切换 Settings|Toggle Settings|설정 토글)/;

test('settings.toggle 命令显本地化 category 前缀 + title', async ({ window }) => {
  // 等就绪
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });

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
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  const settingsOption = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: SETTINGS_TITLE });
  await expect(settingsOption).toBeVisible();
  await expect(settingsOption).toContainText(SETTINGS_CATEGORY);
  await expect(settingsOption).toContainText(SETTINGS_TITLE);
});
