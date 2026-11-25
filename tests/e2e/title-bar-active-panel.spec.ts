// 终端为活动面板时,标题栏 / 窗口标题显示终端名、状态栏不显示被挡住的文件(VSCode 对齐)。
// BDD: src/__tests__/chrome-active-panel/
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile, TERMINAL_INPUT, TERMINAL_PANEL_TAB } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';

test('打开 README.md → 切到终端:标题栏 / 窗口标题为终端名,状态栏无文件;切回编辑器恢复', async ({
  window,
  workspaceRoot,
}) => {
  const ws = path.basename(workspaceRoot);
  await openWorkspaceFile(window, ['README.md']);
  const titleBar = window.locator('header').first();
  const statusBar = window.locator('footer[data-statusbar]');
  await expect(titleBar).toContainText('README.md');
  await expect(statusBar).toContainText('README.md');
  await expect.poll(() => window.title()).toContain('README.md');

  await dockHeaderMoreActionsButton(window).click();
  await window.getByRole('menu').last().getByRole('menuitem', { name: TERMINAL_TAB }).click();
  await expect(window.getByRole('textbox', { name: TERMINAL_INPUT })).toBeVisible({ timeout: 15_000 });
  const terminalTab = window.getByRole('tab').filter({ hasText: TERMINAL_PANEL_TAB });
  const terminalName = ((await terminalTab.first().textContent()) ?? '').match(TERMINAL_PANEL_TAB)![0];

  await expect(titleBar).toContainText(terminalName);
  await expect(titleBar).toContainText(ws);
  await expect(titleBar).not.toContainText('README.md');
  await expect(statusBar).not.toContainText('README.md');
  await expect.poll(() => window.title()).toContain(terminalName);
  expect(await window.title()).not.toContain('README.md');

  await window.getByRole('tab').filter({ hasText: /^(编辑器|Editor|편집기)/ }).first().click();
  await expect(titleBar).toContainText('README.md');
  await expect(statusBar).toContainText('README.md');
  await expect.poll(() => window.title()).toContain('README.md');
});
