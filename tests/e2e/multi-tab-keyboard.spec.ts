// Cmd+Click TabNav item 中键 / TabNav 切 tab 用键盘 — Continuo TabNavItem
// 是 button role=tab,Tab 键导航 + Enter 选中.
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS, editorTab, openWorkspaceFile } from './helpers/editor';

test('TabNav: 点 a.ts tab → tab role=tab + aria-selected=true', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  await expect(window.getByRole('tablist', { name: EDITOR_TABS })).toBeVisible();

  // 点 README.md tab
  const readmeTab = editorTab(window, 'README.md');
  await readmeTab.click();
  await expect(readmeTab).toHaveAttribute('aria-selected', 'true');

  const aTab = editorTab(window, 'a.ts');
  await expect(aTab).toHaveAttribute('aria-selected', 'false');
});
