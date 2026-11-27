// 终端读屏支持(BDD: src/__tests__/terminal-screen-reader/):
//   1. editor.accessibilitySupport 强制 on → 已开终端出现 .xterm-accessibility 可访问树,且含终端输出;off → 树移除
//   2. 终端输入框可访问名随界面语言本地化(「Terminal N…」/「终端 N…」/「터미널 N…」)
import { test, expect } from './fixtures/with-workspace';
import { TERMINAL_INPUT } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';
import { waitForTestHooks } from './helpers/app-ready';
import type { Page } from '@playwright/test';

const setSetting = (page: Page, id: string, v: string) =>
  page.evaluate(([id, v]) => globalThis.__continuoTest!.setSettingValue(id as string, v as string), [id, v] as const);

async function openTerminal(window: Page) {
  await dockHeaderMoreActionsButton(window).click();
  await window.getByRole('menu').last().getByRole('menuitem', { name: TERMINAL_TAB }).click();
  const input = window.getByRole('textbox', { name: TERMINAL_INPUT });
  await expect(input).toBeVisible({ timeout: 15_000 });
  return input;
}

test('读屏优化强制 on → .xterm-accessibility 出现并含输出;off → 移除', async ({ window }) => {
  await waitForTestHooks(window);
  await setSetting(window, 'editor.accessibilitySupport', 'off');
  const input = await openTerminal(window);
  const tree = window.locator('.xterm-accessibility');
  await expect(tree).toHaveCount(0);

  await setSetting(window, 'editor.accessibilitySupport', 'on');
  await expect(tree).toHaveCount(1);
  await input.focus();
  await window.keyboard.type('echo SR_MARK_$((40+2))');
  await window.keyboard.press('Enter');
  await expect(tree).toContainText('SR_MARK_42', { timeout: 15_000 });

  await setSetting(window, 'editor.accessibilitySupport', 'off');
  await expect(tree).toHaveCount(0);
});

test('终端输入框可访问名本地化:切换语言即时更新', async ({ window }) => {
  await waitForTestHooks(window);
  await setSetting(window, 'general.language', 'en');
  const input = await openTerminal(window);
  await expect(input).toHaveAttribute('aria-label', /^Terminal \d+/);
  await setSetting(window, 'general.language', 'zh');
  await expect(input).toHaveAttribute('aria-label', /^终端 \d+/);
  await setSetting(window, 'general.language', 'ko');
  await expect(input).toHaveAttribute('aria-label', /^터미널 \d+/);
  await setSetting(window, 'general.language', 'en');
  await expect(input).toHaveAttribute('aria-label', /^Terminal \d+/);
});
