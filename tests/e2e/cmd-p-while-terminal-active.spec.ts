// Terminal panel active 时,Cmd+P 仍可全局打开 Quick Open(useQuickOpenHotkey / usePickerToggleHotkey 监 document).
import { test, expect } from './fixtures/with-workspace';
import { QUICK_OPEN_SEARCH } from './helpers/palette';
import { waitForTestHooks } from './helpers/app-ready';

const TERMINAL_TAB = /^(终端|Terminal|터미널)(\s|$)/;

test('Terminal active + Cmd+P → Quick Open modal 显', async ({ window }) => {
  // 走真实 terminal.new command 创建 session-bound Terminal panel.
  await waitForTestHooks(window)
  const created = await window.evaluate(() =>
    (
      window as unknown as {
        __continuoTest: { executeCommand: (id: string) => Promise<boolean> };
      }
    ).__continuoTest.executeCommand('terminal.new'),
  );
  expect(created).toBe(true);
  const terminalTab = window.getByRole('tab', { name: TERMINAL_TAB });
  await expect(terminalTab).toBeVisible({ timeout: 15_000 });
  await terminalTab.click();
  await expect(terminalTab).toHaveAttribute('aria-selected', 'true', {
    timeout: 15_000,
  });

  // Cmd+P 触发 quick-open(全局 listener,Terminal 不阻断)
  await window.keyboard.press('ControlOrMeta+KeyP');

  await expect(
    window.getByRole('combobox', { name: QUICK_OPEN_SEARCH }),
  ).toBeVisible({ timeout: 5_000 });
});
