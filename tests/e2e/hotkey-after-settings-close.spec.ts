// 开 Settings → 关 → Cmd+Shift+P → CommandPalette 仍可唤起.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const CLOSE_SETTINGS = /^(关闭 Settings|Close Settings|Settings 닫기)$/;
const SETTINGS_NAV = /^(设置分类|Setting categories|설정 카테고리)$/;
const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;

test('Settings 开关后 Cmd+Shift+P 仍唤起 CommandPalette', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  await window.getByRole('button', { name: CLOSE_SETTINGS }).click();
  await window.waitForTimeout(400);
  await expect(nav).toBeHidden();

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
  await expect(
    window.getByRole('combobox', { name: COMMAND_SEARCH }),
  ).toBeVisible({ timeout: 5_000 });
});
