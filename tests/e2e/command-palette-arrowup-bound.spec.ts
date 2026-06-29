// CommandPalette ArrowUp 在 selectedIndex=0 → wrap 到末项.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;
const COMMAND_LIST = /^(命令列表|Command list|명령어 목록)$/;

test('ArrowUp 在第一项 → wrap 到末项', async ({ window }) => {
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

  const items = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option');
  const count = await items.count();
  expect(count).toBeGreaterThan(0);

  await window.keyboard.press('ArrowUp');

  // 末项底色 active
  const lastClass = await items.last().getAttribute('class');
  expect(lastClass).toContain('bg-hover');
});
