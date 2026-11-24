// CommandPalette ArrowUp 在 selectedIndex=0 → wrap 到末项.
import { test, expect } from './fixtures/electron-app';
import { ROW_SELECTED, COMMAND_SEARCH, COMMAND_LIST } from './helpers/palette';
import { SETTINGS } from './helpers/settings';

test('ArrowUp 在第一项 → wrap 到末项', async ({ window }) => {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        // 平台主修饰键:mac = Cmd,其它 = Ctrl(mac 上面板热键只认 Cmd)
        ctrlKey: !navigator.platform.toLowerCase().includes('mac'),
        metaKey: navigator.platform.toLowerCase().includes('mac'),
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

  // 末项选中,第一项不再选中
  await expect(items.last()).toHaveClass(ROW_SELECTED);
  await expect(items.first()).not.toHaveClass(ROW_SELECTED);
});
