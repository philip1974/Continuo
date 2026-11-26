// 用户打开 / 显示面板后焦点进面板(BDD: src/__tests__/open-panel-focus/):dock「⋯」/ 命令面板打开输出后焦点在输出面板;
// ⌘, 重新激活后台 tab 里的设置 → 搜索框获焦;冷启动 ⇧⌘F 后立刻键入不丢字。
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import { EXPLORER_MORE_ACTIONS } from './helpers/explorer';
import { OUTPUT_EMPTY, OUTPUT_PANEL } from './helpers/output';
import { COMMAND_LIST, commandPaletteInput, openCommandPalette } from './helpers/palette';
import { dispatchModKey } from './helpers/hotkeys';
import { openSettings, settingsSearch } from './helpers/settings';

/** 焦点在输出面板(空输出面板的根落点)里,而不是 body。 */
const focusInOutput = (window: Page) =>
  window.evaluate(() => document.activeElement?.closest('[data-panel-focus-root]') != null);

test('dock「⋯」→ 输出:焦点进新输出面板', async ({ window }) => {
  await waitForAppReady(window);
  const moreBtn = window.getByRole('button', { name: EXPLORER_MORE_ACTIONS }).last();
  await moreBtn.click();
  await window.getByRole('menu').last().getByRole('menuitem', { name: OUTPUT_PANEL }).click();
  await expect(window.getByText(OUTPUT_EMPTY)).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => focusInOutput(window)).toBe(true);
});

test('命令面板「查看:显示输出」(键盘执行)→ 焦点进输出面板', async ({ window }) => {
  await waitForAppReady(window);
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await input.fill('Show Output');
  await expect(
    window.getByRole('listbox', { name: COMMAND_LIST }).getByRole('option').filter({ hasText: /(显示输出|Show Output|출력 표시)/ }),
  ).toHaveCount(1);
  await window.keyboard.press('Enter');
  await expect(input).toBeHidden({ timeout: 5_000 });
  await expect(window.getByText(OUTPUT_EMPTY)).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => focusInOutput(window)).toBe(true);
});

test('设置在同组后台 tab → ⌘, 重新激活并聚焦设置搜索框', async ({ window }) => {
  await openSettings(window);
  await waitForTestHooks(window);
  // 在设置所在组(活动组)再开一个面板,设置退到后台 tab;焦点随之进新面板
  await window.evaluate(() => globalThis.__continuoTest!.openOrFocusPanel('output', 'output', 'Output'));
  await expect(window.getByText(OUTPUT_EMPTY)).toBeVisible({ timeout: 10_000 });
  await expect(settingsSearch(window)).toBeHidden();
  await dispatchModKey(window, ',');
  await expect(settingsSearch(window)).toBeFocused({ timeout: 5_000 });
});

test('冷启动第一次 ⇧⌘F 后立刻键入(间隔 40ms)不丢字', async ({ window }) => {
  await waitForAppReady(window);
  await waitForTestHooks(window);
  // 启动空闲预取在就绪后很快完成;给它一个空闲回调的机会(真实用户启动后到第一次按键远长于此)
  await window.evaluate(() => new Promise<void>((r) => requestIdleCallback(() => r())));
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  await window.keyboard.type('abc', { delay: 40 });
  await expect(window.getByRole('textbox', { name: /^(搜索|Search|검색)$/ })).toHaveValue('abc');
});
