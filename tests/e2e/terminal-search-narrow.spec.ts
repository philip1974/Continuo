// 窄终端分栏里 ⌘F:搜索条自身收窄,输入框与关闭按钮完整落在面板可见区内(对齐 VSCode 查找框窄时收窄)。
// BDD: src/__tests__/terminal-search/(S15)
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { TERMINAL_PANEL_TAB } from './helpers/editor';

const SEARCH_INPUT = /^(搜索|Find|찾기)$/;

test('窄终端分栏 ⌘F:输入框与关闭按钮在面板内可见', async ({ window, electronApp }) => {
  await waitForTestHooks(window);
  await window.locator('text=README.md').first().click();
  expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB }).first()).toBeVisible({ timeout: 15_000 });
  await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.setMinimumSize(400, 270);
    w.setContentSize(560, 400);
  });
  const xterm = window.locator('.xterm').first();
  await expect(xterm).toBeVisible({ timeout: 15_000 });
  await xterm.click();
  await window.keyboard.press('ControlOrMeta+f');
  const input = window.getByRole('textbox', { name: SEARCH_INPUT });
  await expect(input).toBeFocused({ timeout: 5_000 });

  const geo = await input.evaluate((el) => {
    const view = el.closest('.dv-view') ?? el.closest('[data-terminal-drop-zone]')!;
    const v = view.getBoundingClientRect();
    const i = el.getBoundingClientRect();
    const close = el.parentElement!.querySelector('button:last-of-type')!.getBoundingClientRect();
    return { viewLeft: v.left, viewRight: v.right, inputLeft: i.left, inputRight: i.right, closeRight: close.right };
  });
  // 分栏确实窄于原先固定宽度的搜索条(约 406px),否则此用例没有区分力。
  expect(geo.viewRight - geo.viewLeft).toBeLessThan(400);
  expect(geo.inputLeft).toBeGreaterThanOrEqual(geo.viewLeft - 0.5);
  expect(geo.closeRight).toBeLessThanOrEqual(geo.viewRight + 0.5);
  expect(geo.inputRight - geo.inputLeft).toBeGreaterThanOrEqual(60);
});
